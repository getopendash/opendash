/**
 * Working in an App: who owns a record, where it stands, a note and when to follow up, kept in
 * OpenDash beside the warehouse's rows and never written back to them. Read by anyone who reads the App (under the
 * revision they draw); changed by its readers who may work (not viewers, checked by the API), each change kept with
 * who made it and when. A query's statuses are its own (the definition says them).
 */
import { isServiceDataset } from "@opendash/apps/dashboard";
import { isUuid, sql, type TenantTx, uuidv7 } from "@opendash/db";
import type { Viewer } from "../runs/ledger";
import { lockFor } from "../tenancy/locks";
import { ownerOf } from "./data";
import { pinKey, serviceNow } from "./service";
import { ACTIONS_OFF, actionsOff, DashboardProblem, definitionAt } from "./store";

export interface RecordWork {
  key: string;
  ownerId: string | null;
  status: string | null;
  note: string | null;
  followUp: string | null;
  updatedBy: string | null;
  updatedAt: string;
}

const MAX_KEYS = 200;
/** Records an App's page may change in ten minutes, per person (its code sends them; the page shows each). */
const APP_WORK_PER_TEN_MINUTES = 60;

/** The query whose records are worked on, as the revision draws it; or none. */
async function workingGrid(
  tx: TenantTx,
  viewer: Viewer,
  input: { dashboardId: string; revision: string; section: string },
) {
  const at = await definitionAt(tx, viewer, input.dashboardId, input.revision);
  if (!at) return null;
  // The query declares what's worked on: the grid on it names the query (its id in place of a section's).
  const q = Object.hasOwn(at.definition.queries, input.section) ? at.definition.queries[input.section] : undefined;
  const work = q?.work;
  if (!q || !work) return null;
  const own = Object.hasOwn(at.definition.datasets ?? {}, q.source.dataset)
    ? at.definition.datasets?.[q.source.dataset]
    : undefined;
  const service = own && isServiceDataset(own) && own.connection === q.source.connection ? own : null;
  return {
    connection: q.source.connection,
    dataset: q.source.dataset,
    statuses: work.statuses,
    service,
    // A draft someone else saved last: its work is read, never changed from it (its code is theirs).
    writable: !actionsOff(at, viewer),
  };
}

/**
 * The keys this reader may see work on, and where that work is kept. A list read with each person's own account (a
 * personal service) shows each reader their own records: only keys in the read their page shows (the snapshot it
 * names) are answered, and their work is kept for them alone (the same key in two accounts is two records). Anything
 * read from a source everyone reads alike is answered as asked, its work shared.
 */
async function visibleKeys(
  tx: TenantTx,
  viewer: Viewer,
  dashboardId: string,
  grid: NonNullable<Awaited<ReturnType<typeof workingGrid>>>,
  keys: string[],
  snapshot: string | undefined,
): Promise<{ keys: string[]; dataset: string }> {
  const shared = { keys, dataset: grid.dataset };
  if (!grid.service) return shared;
  const now = await serviceNow(tx, viewer.orgId, grid.service, {
    owner: await ownerOf(tx, viewer.orgId, dashboardId),
    asker: viewer.userId,
  });
  const none = { keys: [], dataset: grid.dataset };
  if (!now.ok) return none;
  if (now.scope === "org") return shared;
  if (!snapshot || !isUuid(snapshot) || !grid.service.key || !viewer.userId) return none;
  const rows = await tx.execute<{ k: string }>(sql`
    select distinct row->>${grid.service.key} as k
    from app.dashboard_result r, jsonb_array_elements(r.result->'rows') as row
    where r.org_id = ${viewer.orgId} and r.cache_key = ${pinKey(now.identity, snapshot)} and r.status = 'ok'
      and r.expires_at > now()`);
  const seen = new Set(rows.map((r) => r.k));
  return { keys: keys.filter((k) => seen.has(k)), dataset: `${grid.dataset}@${viewer.userId}` };
}

/** The work on these records of a grid, for someone who reads the dashboard. */
export async function readWork(
  tx: TenantTx,
  viewer: Viewer,
  input: { dashboardId: string; revision: string; section: string; keys: string[]; snapshot?: string },
): Promise<RecordWork[] | null> {
  const grid = await workingGrid(tx, viewer, input);
  if (!grid) return null;
  const { keys, dataset } = await visibleKeys(
    tx,
    viewer,
    input.dashboardId,
    grid,
    [...new Set(input.keys.map(String))].filter((k) => k.length <= 200).slice(0, MAX_KEYS),
    input.snapshot,
  );
  if (!keys.length) return [];
  const rows = await tx.execute<{
    record_key: string;
    owner_id: string | null;
    status: string | null;
    note: string | null;
    follow_up: string | null;
    updated_by: string | null;
    updated_at: string;
  }>(sql`
    select record_key, owner_id, status, note, follow_up::text as follow_up, updated_by, updated_at::text as updated_at
    from app.dashboard_work
    where org_id = ${viewer.orgId} and dashboard_id = ${input.dashboardId} and connection_id = ${grid.connection}
      and dataset = ${dataset}
      and record_key in (${sql.join(
        keys.map((k) => sql`${k}`),
        sql`, `,
      )})`);
  return rows.map((r) => ({
    key: r.record_key,
    ownerId: r.owner_id,
    status: r.status,
    note: r.note,
    followUp: r.follow_up,
    updatedBy: r.updated_by,
    updatedAt: new Date(r.updated_at).toISOString(),
  }));
}

/** Changes a record's work (only what's given), checked against the grid's statuses and the workspace's people. */
export async function setWork(
  tx: TenantTx,
  viewer: Viewer & { userId: string },
  input: {
    dashboardId: string;
    revision: string;
    section: string;
    key: string;
    ownerId?: string | null;
    status?: string | null;
    note?: string | null;
    followUp?: string | null;
    snapshot?: string;
  },
): Promise<RecordWork> {
  // Its history: each field given, as written, by whom. A write that gives none changes nothing and is
  // refused: it would add a record that leaves no history, so it would never count toward the rate cap below.
  const changes = (
    [
      ["owner", input.ownerId],
      ["status", input.status],
      ["note", input.note === undefined ? undefined : input.note?.trim() || null],
      ["follow_up", input.followUp],
    ] as const
  ).filter(([, v]) => v !== undefined);
  if (!changes.length) {
    throw new DashboardProblem("invalid", "Say what changes: an owner, a status, a note or a follow-up.");
  }
  const grid = await workingGrid(tx, viewer, input);
  if (!grid) throw new DashboardProblem("not_found", "That isn't a list you can work in here.");
  if (!grid.writable) throw new DashboardProblem("invalid", ACTIONS_OFF);
  const visible = await visibleKeys(tx, viewer, input.dashboardId, grid, [String(input.key)], input.snapshot);
  if (!visible.keys.length) {
    throw new DashboardProblem("invalid", "That row isn't in the list as you see it: refresh it and try again.");
  }
  const dataset = visible.dataset;
  // An App is code: a write it sends is the person's only as far as the page can show it (with Undo,
  // the page's own), so it's held to a rate on the server: code can't rewrite a list's work in a burst. Every write
  // counts (its history keeps one row a field changed), one at a time per person and App: two sent together can't
  // both slip under the cap.
  await lockFor(tx, `app-work:${viewer.orgId}:${input.dashboardId}:${viewer.userId}`);
  const [recent] = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from app.dashboard_work_event
    where org_id = ${viewer.orgId} and dashboard_id = ${input.dashboardId} and by = ${viewer.userId}
      and at > now() - interval '10 minutes'`);
  if ((recent?.n ?? 0) >= APP_WORK_PER_TEN_MINUTES) {
    throw new DashboardProblem("invalid", "That's a lot of changes at once: wait a few minutes and try again.");
  }
  const key = String(input.key);
  if (!key || key.length > 200) throw new DashboardProblem("invalid", "That isn't one of its records.");
  if (input.status !== undefined && input.status !== null && !grid.statuses.includes(input.status)) {
    throw new DashboardProblem("invalid", `Its statuses are ${grid.statuses.join(", ")}.`);
  }
  if (input.note !== undefined && input.note !== null && input.note.length > 2000) {
    throw new DashboardProblem("invalid", "A note is at most 2,000 characters.");
  }
  // A real day: 2026-02-30 isn't one (never rolled into March).
  const realDay = (d: string) =>
    /^\d{4}-\d{2}-\d{2}$/.test(d) &&
    !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) &&
    new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
  if (input.followUp && !realDay(input.followUp)) {
    throw new DashboardProblem("invalid", "A follow-up is a day, like 2026-11-20.");
  }
  if (input.ownerId) {
    const [m] = isUuid(input.ownerId)
      ? await tx.execute<{ role: string | null }>(sql`select app.member_role(${input.ownerId}::uuid) as role`)
      : [];
    if (!m?.role) throw new DashboardProblem("invalid", "A record's owner is someone in this workspace.");
  }
  const set = <T>(v: T | undefined, column: string) =>
    v === undefined ? sql`` : sql`, ${sql.raw(column)} = excluded.${sql.raw(column)}`;
  const [row] = await tx.execute<{
    record_key: string;
    owner_id: string | null;
    status: string | null;
    note: string | null;
    follow_up: string | null;
    updated_by: string | null;
    updated_at: string;
  }>(sql`
    insert into app.dashboard_work (org_id, dashboard_id, connection_id, dataset, record_key, owner_id, status, note,
      follow_up, updated_by)
    values (${viewer.orgId}, ${input.dashboardId}, ${grid.connection}, ${dataset}, ${key}, ${input.ownerId ?? null},
      ${input.status ?? null}, ${input.note?.trim() || null}, ${input.followUp ?? null}::date, ${viewer.userId})
    on conflict (org_id, dashboard_id, connection_id, dataset, record_key) do update set updated_by = excluded.updated_by,
      updated_at = now()${set(input.ownerId, "owner_id")}${set(input.status, "status")}${set(input.note, "note")}${set(
        input.followUp,
        "follow_up",
      )}
    returning record_key, owner_id, status, note, follow_up::text as follow_up, updated_by, updated_at::text as updated_at`);
  if (!row) throw new DashboardProblem("invalid", "It wasn't saved.");
  for (const [field, value] of changes) {
    await tx.execute(sql`
      insert into app.dashboard_work_event (org_id, id, dashboard_id, connection_id, dataset, record_key, field, value, by)
      values (${viewer.orgId}, ${uuidv7()}, ${input.dashboardId}, ${grid.connection}, ${dataset}, ${key}, ${field},
        ${value ?? null}, ${viewer.userId})`);
  }
  return {
    key: row.record_key,
    ownerId: row.owner_id,
    status: row.status,
    note: row.note,
    followUp: row.follow_up,
    updatedBy: row.updated_by,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export interface WorkEvent {
  field: "owner" | "status" | "note" | "follow_up";
  value: string | null;
  by: string | null;
  at: string;
}

/** A worked record's history, newest first (at most 20), for someone who reads it. */
export async function readWorkHistory(
  tx: TenantTx,
  viewer: Viewer,
  input: { dashboardId: string; revision: string; section: string; key: string; snapshot?: string },
): Promise<WorkEvent[] | null> {
  const grid = await workingGrid(tx, viewer, input);
  if (!grid) return null;
  const visible = await visibleKeys(
    tx,
    viewer,
    input.dashboardId,
    grid,
    [String(input.key).slice(0, 200)],
    input.snapshot,
  );
  const [key] = visible.keys;
  if (key === undefined) return [];
  const rows = await tx.execute<{ field: WorkEvent["field"]; value: string | null; by: string | null; at: string }>(sql`
    select field, value, by, at::text as at from app.dashboard_work_event
    where org_id = ${viewer.orgId} and dashboard_id = ${input.dashboardId} and connection_id = ${grid.connection}
      and dataset = ${visible.dataset} and record_key = ${key}
    order by at desc, id desc limit 20`);
  return rows.map((r) => ({ ...r, at: new Date(r.at).toISOString() }));
}

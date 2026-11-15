/**
 * A dashboard reading a service: a service dataset is one call of an MCP tool, made as the dashboard's owner and seen
 * by its owner alone. Every request checks again
 * that the call may run as it was checked (the owner asking, the server and tool allowed in dashboards and unchanged,
 * the owner's account still connected) and keys its answers by all of that, so nothing cached outlives a change. The
 * worker fetches the tool's answer once a freshness bucket, shapes it into rows (a snapshot, kept beside the answers),
 * and runs the same compiler over it, in Postgres: every grain, measure and filter means what it means on a warehouse.
 */
import { createHash } from "node:crypto";
import { isServiceDataset, ownCatalogDataset, type ServiceDataset } from "@opendash/apps/dashboard";
import { SHAPER, type Shaped, ShapeProblem, shapeRows, type ToolAnswer } from "@opendash/apps/dashboard/service";
import type { Catalog } from "@opendash/apps/protocol";
import { type SQL, sql, type TenantTx, uuidv7 } from "@opendash/db";
import { callTool } from "../mcp/executor";
import { loadServer, type McpDeps, resolveConnection } from "../mcp/shared";
import type { DatasetSpec } from "../semantic/spec";
import type { LoadedCatalog } from "./catalog";
import type { CompiledQuery } from "./compile";

/** Where the dataset's SQL reads the snapshot: bound as one parameter, never written into the SQL. */
const SNAPSHOT = "$od_snapshot$";

const PG_TYPES: Record<ServiceDataset["columns"][number]["type"], string> = {
  string: "text",
  number: "float8",
  boolean: "boolean",
  time: "timestamptz",
  date: "date",
};

/** What a request may read: the call's identity (part of every key), or why it can't run now. */
export type ServiceNow =
  | {
      ok: true;
      identity: string;
      serverName: string;
      tool: string;
      arguments: Record<string, unknown>;
      /** Whose account it reads with: the reader's own, or the workspace's (the same for everyone). */
      scope: "personal" | "org";
    }
  | { ok: false; refused: string };

const stable = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(stable).join(",")}]`
    : v && typeof v === "object"
      ? `{${Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
          .join(",")}}`
      : JSON.stringify(v ?? null);

/**
 * Whether this person may read the dashboard's service dataset now, and the identity of the call it reads: the
 * server, the connection it runs as (their own account on a personal server, the workspace's on a shared one) and
 * that account, the tool as it was checked, the arguments, the shape and the shaper. Never anyone else's account:
 * each viewer reads with their own, and someone with none is told to connect.
 */
export async function serviceNow(
  tx: TenantTx,
  orgId: string,
  ds: ServiceDataset,
  people: { owner: string; asker: string | null },
): Promise<ServiceNow> {
  const server = await loadServer(tx, orgId, ds.connection);
  const name = server?.name ?? "The service";
  // A person reads it, as themself (an organization key has no account to read with).
  if (!people.asker) return { ok: false, refused: `${name} is read with a person's own account: sign in to see it.` };
  if (server?.status !== "active") return { ok: false, refused: `${name} is turned off or gone.` };
  if (!server.dashboards_allowed) {
    return {
      ok: false,
      refused: `${name} isn't allowed in dashboards: an admin turns it on under Data → Connections.`,
    };
  }
  const [tool] = await tx.execute<{
    digest: string;
    status: string;
    tier: string;
    dashboards_allowed: boolean;
    read_only: boolean;
  }>(sql`
    select digest, status, tier, dashboards_allowed, coalesce((annotations->>'readOnlyHint')::boolean, false) as read_only
    from app.mcp_tool where org_id = ${orgId} and server_id = ${server.id} and name = ${ds.service.tool}`);
  if (!tool || tool.status === "removed") return { ok: false, refused: `${name} has no tool ${ds.service.tool} now.` };
  if (!tool.read_only || tool.tier !== "always" || !tool.dashboards_allowed || tool.status !== "active") {
    return {
      ok: false,
      refused: `${name}'s ${ds.service.tool} isn't allowed in dashboards (it must only read, run without asking, and be turned on for dashboards under Data → Connections).`,
    };
  }
  if (ds.service.digest && ds.service.digest !== tool.digest) {
    return {
      ok: false,
      refused: `${name}'s ${ds.service.tool} changed since this was built: ask the analyst to check it again.`,
    };
  }
  const found = await resolveConnection(tx, { orgId, userId: people.asker }, server);
  if (found.kind !== "found") {
    return {
      ok: false,
      refused:
        found.kind === "missing" && found.scope === "personal"
          ? `Connect your ${name} account under Data → Connections to see this: it's read with each person's own.`
          : `${name} isn't connected for the workspace yet: an admin connects it under Data → Connections.`,
    };
  }
  if (found.connection.status !== "ready") {
    return { ok: false, refused: `Reconnect ${name} under Data → Connections to see this.` };
  }
  const identity = createHash("sha256")
    .update(
      stable({
        server: server.id,
        connection: found.connection.id,
        account: found.connection.account_key ?? found.connection.account ?? "",
        // A key replaced or an account signed in again is a new revision: nothing read before is reused.
        revision: found.connection.revision,
        // Whose account: the reader's own on a personal server; the workspace's, the same for everyone, on a shared one.
        reader: found.scope === "personal" ? people.asker : "org",
        tool: ds.service.tool,
        digest: tool.digest,
        arguments: ds.service.arguments,
        rows: ds.rows ?? "",
        columns: ds.columns,
        shaper: SHAPER,
      }),
    )
    .digest("hex")
    .slice(0, 32);
  return {
    ok: true,
    identity,
    serverName: server.name,
    tool: ds.service.tool,
    arguments: ds.service.arguments,
    scope: found.scope,
  };
}

/** The catalog a service dataset's queries compile against: its declared columns, over the snapshot. */
export function serviceCatalog(serverId: string, serverName: string, name: string, ds: ServiceDataset): LoadedCatalog {
  const columns = ds.columns.map((c) => `${JSON.stringify(c.name)} ${PG_TYPES[c.type]}`).join(", ");
  const spec = {
    ref: name,
    label: ds.title,
    sql: `select * from jsonb_to_recordset(${SNAPSHOT}::jsonb) as r(${columns})`,
    columns: ds.columns.map((c) => ({ name: c.name, type: c.type === "date" ? "time" : c.type })),
    primary_key: ds.key ? [ds.key] : [],
    measures: [],
    segments: [],
    relationships: [],
  } as unknown as DatasetSpec;
  const catalog: Catalog = { [name]: ownCatalogDataset(ds) };
  return {
    connectionId: serverId,
    sourceName: serverName,
    dialect: "postgres",
    catalog,
    datasets: new Map([[name, { spec, itemId: "", version: 0, released: false }]]),
    metrics: new Map(),
  } as unknown as LoadedCatalog;
}

/** The key a snapshot is kept under: the call's identity, in its freshness bucket. */
export const snapshotKey = (identity: string, bucket: Date) => `svc:${identity}:${bucket.toISOString()}`;

/**
 * The key one snapshot is also kept under, by its own id: what a drill opened from a number reads, so its rows are
 * the ones that made the number (never a newer read). The identity is the reader's access now, so a pin is only ever
 * read by someone who may read it.
 */
export const pinKey = (identity: string, id: string) => `svcpin:${identity}:${id}`;

export interface Snapshot {
  /** This read's own id: a drill pins it. */
  id: string;
  /** The freshness bucket it was read in: a pinned drill's dates are worked out from it. */
  bucket: string;
  rows: Shaped["rows"];
  cut: number;
  incomplete: boolean;
  unread: Record<string, number>;
  missing: string[];
  fetchedAt: string;
  /** The service generation it was read in: an answer from a read a change overtook is made again. */
  generation?: string;
}

/** Calls in flight in this process, by snapshot key: a page's sections on one dataset make one call. */
const inFlight = new Map<string, Promise<Snapshot | { error: string }>>();
/** Calls running now, by server: at most two at a time each. */
const running = new Map<string, number>();
const PER_SERVER = 2;

async function slot(serverId: string, signal?: AbortSignal): Promise<() => void> {
  for (;;) {
    const n = running.get(serverId) ?? 0;
    if (n < PER_SERVER) {
      running.set(serverId, n + 1);
      return () => running.set(serverId, Math.max(0, (running.get(serverId) ?? 1) - 1));
    }
    if (signal?.aborted) throw new Error("cancelled");
    await new Promise((r) => setTimeout(r, 150));
  }
}

/**
 * The snapshot a request reads: kept for its bucket, else fetched now as the reader (through the one executor, which
 * checks everything again) and shaped. An answer that isn't data, or a refusal, is an error, never rows.
 */
export async function serviceSnapshot(
  deps: { withTenant: <T>(orgId: string, fn: (tx: TenantTx) => Promise<T>) => Promise<T>; mcp?: McpDeps },
  input: {
    orgId: string;
    owner: string;
    ds: ServiceDataset;
    key: string;
    /** The account scope the key was made for: a call that ran under another (the server changed meanwhile) is kept nowhere. */
    scope: "personal" | "org";
    /** A pinned snapshot (by its pin key): read while kept, never fetched again. */
    pinned?: boolean;
    /** Who the read is recorded for: the dashboard asking, and the bucket the key was made in. */
    dashboardId?: string;
    bucket?: Date;
    signal?: AbortSignal;
  },
): Promise<Snapshot | { error: string; queryRunId?: string }> {
  const [kept] = await deps.withTenant(input.orgId, (tx) =>
    tx.execute<{ result: Snapshot }>(sql`
      select result from app.dashboard_result
      where org_id = ${input.orgId} and cache_key = ${input.key} and status = 'ok' and expires_at > now()`),
  );
  if (kept) return kept.result;
  if (input.pinned) {
    return { error: "These rows were read a while ago and aren't kept any more: refresh the page to read them again." };
  }
  // The workspace's service generation as this read begins: a change made meanwhile means it isn't kept, and a read
  // shared by later requests is one begun in the same generation.
  const began = await deps.withTenant(input.orgId, (tx) => serviceGeneration(tx, input.orgId));
  const sharedKey = `${input.key}|${began}`;
  const had = inFlight.get(sharedKey);
  if (had) return had;
  const work = (async (): Promise<Snapshot | { error: string; queryRunId?: string }> => {
    if (!deps.mcp) return { error: "Services aren't set up on this server." };
    const release = await slot(input.ds.connection, input.signal);
    let outcome: Awaited<ReturnType<typeof callTool>>;
    const started = Date.now();
    const id = uuidv7();
    // Each read is recorded (a query_run of engine mcp), for the person it read as, without its rows.
    const record = (r: {
      ok: boolean;
      error?: string;
      rows?: number;
      incomplete?: boolean;
      server?: string;
      extra?: object;
    }) => {
      const dashboardId = input.dashboardId;
      return dashboardId
        ? deps
            .withTenant(input.orgId, (tx) =>
              insertServiceRun(tx, {
                id,
                orgId: input.orgId,
                dashboardId,
                ds: input.ds,
                reader: input.scope === "personal" ? input.owner : "org",
                scope: input.scope,
                key: input.key,
                durationMs: Date.now() - started,
                ...r,
              }),
            )
            .catch(() => null)
        : Promise.resolve(null);
    };
    try {
      outcome = await callTool(
        deps.mcp,
        { orgId: input.orgId, userId: input.owner },
        {
          serverId: input.ds.connection,
          tool: input.ds.service.tool,
          arguments: input.ds.service.arguments,
          via: "dashboard",
          policy: { readsOnly: true },
          ...(input.signal ? { signal: input.signal } : {}),
        },
      );
    } catch (error) {
      const message = `The service didn't answer: ${error instanceof Error ? error.message : "it failed"}.`;
      const run = await record({ ok: false, error: message });
      return { error: message, ...(run ? { queryRunId: run } : {}) };
    } finally {
      release();
    }
    if (outcome.state !== "ready") {
      // Signed out, refused or busy: nothing kept from before is read again for this account.
      if (outcome.state !== "rate_limited") await forgetSnapshots(deps, input.orgId);
      await record({ ok: false, error: `Not read: ${outcome.state}`, server: outcome.server?.name ?? "" });
      return {
        error:
          outcome.state === "rate_limited"
            ? `${outcome.server.name} is busy: try again in a minute.`
            : outcome.state === "blocked"
              ? outcome.message
              : outcome.state === "consent"
                ? `${outcome.server.name}'s ${outcome.tool} needs someone to allow it first.`
                : `Reconnect ${outcome.server.name} under Data → Connections to see this.`,
      };
    }
    // Read under another account scope than the key says (a server switched between shared and personal while this
    // ran): never kept, so no one's own rows land under a key everyone reads.
    if (outcome.scope !== input.scope) {
      await record({ ok: false, error: "Read under another account scope", server: outcome.server.name });
      return { error: `${outcome.server.name} changed how it's connected: try again.` };
    }
    let shaped: Shaped;
    try {
      shaped = shapeRows(outcome.result as ToolAnswer, input.ds);
    } catch (error) {
      if (error instanceof ShapeProblem) {
        const run = await record({ ok: false, error: error.message, server: outcome.server.name });
        return { error: error.message, ...(run ? { queryRunId: run } : {}) };
      }
      throw error;
    }
    // A column the answer no longer has would draw as empty groups: refused, said in words.
    if (shaped.rows.length && shaped.missing.length) {
      await record({ ok: false, error: `Missing: ${shaped.missing.join(", ")}`, server: outcome.server.name });
      return {
        error: `${shaped.missing.join(", ")} ${shaped.missing.length === 1 ? "wasn't" : "weren't"} in the service's answer: ask the analyst to check this dataset again.`,
      };
    }
    const snapshot: Snapshot = {
      ...shaped,
      id,
      bucket: (input.bucket ?? new Date()).toISOString(),
      fetchedAt: new Date().toISOString(),
      generation: began,
    };
    const identity = input.key.split(":")[1] ?? "";
    // Kept under its bucket (what a page reads) and under its own id (what a drill from it reads), never overwritten,
    // with its record, in one transaction. Not kept when the service was changed through OpenDash while it was read.
    await deps.withTenant(input.orgId, async (tx) => {
      if (input.dashboardId) {
        await insertServiceRun(tx, {
          id,
          orgId: input.orgId,
          dashboardId: input.dashboardId,
          ds: input.ds,
          reader: input.scope === "personal" ? input.owner : "org",
          scope: input.scope,
          key: input.key,
          durationMs: Date.now() - started,
          ok: true,
          rows: shaped.rows.length,
          incomplete: shaped.incomplete,
          server: outcome.server.name,
          extra: { cut: shaped.cut, unread: Object.values(shaped.unread).reduce((a, b) => a + b, 0) },
        });
      }
      // Kept only if no change came meanwhile; a change waits for this to commit (and then drops it).
      if ((await serviceGeneration(tx, input.orgId, true)) !== began) return;
      await tx.execute(sql`
        insert into app.dashboard_result (org_id, cache_key, status, result, expires_at)
        values (${input.orgId}, ${input.key}, 'ok', ${JSON.stringify(snapshot)}::jsonb, now() + interval '20 minutes')
        on conflict (org_id, cache_key) do update set result = excluded.result, status = 'ok', error = null,
          created_at = now(), expires_at = excluded.expires_at`);
      await tx.execute(sql`
        insert into app.dashboard_result (org_id, cache_key, status, result, expires_at)
        values (${input.orgId}, ${pinKey(identity, id)}, 'ok', ${JSON.stringify(snapshot)}::jsonb,
          now() + interval '20 minutes')
        on conflict (org_id, cache_key) do nothing`);
    });
    return snapshot;
  })();
  inFlight.set(sharedKey, work);
  try {
    return await work;
  } finally {
    inFlight.delete(sharedKey);
  }
}

/**
 * Every kept snapshot in this organization, gone: an account was signed out or refused, and a snapshot's key is a
 * hash, so none is read again for any account until fetched anew. (Answers on them are keyed by the same identity,
 * and every request checks the account first.)
 */
async function forgetSnapshots(
  deps: { withTenant: <T>(orgId: string, fn: (tx: TenantTx) => Promise<T>) => Promise<T> },
  orgId: string,
) {
  await deps.withTenant(orgId, async (tx) => {
    await bumpGeneration(tx, orgId);
    await tx.execute(sql`delete from app.dashboard_result where org_id = ${orgId} and cache_key like 'svc%'`);
  });
}

/** Where the generation is kept: never a key the cleanups above drop, and never expiring. */
const GENERATION = "odgen:service";

/**
 * Moves the generation, first: it waits for any read or answer being kept under the old one (they hold the row for
 * share), so what's dropped next includes them, and anything kept after sees the new one.
 */
async function bumpGeneration(tx: TenantTx, orgId: string) {
  await tx.execute(sql`
    insert into app.dashboard_result (org_id, cache_key, status, result, expires_at)
    values (${orgId}, ${GENERATION}, 'ok', ${JSON.stringify({ at: uuidv7() })}::jsonb, 'infinity')
    on conflict (org_id, cache_key) do update set result = excluded.result, created_at = now()`);
}

/**
 * A service was changed through OpenDash (a row's action): what its snapshots said is out of date, and so are the
 * answers made from them. Both are dropped, so every page reads it again; pinned snapshots stay (a drill already
 * open still shows the rows its number was made from).
 */
export async function serviceChanged(tx: TenantTx, orgId: string) {
  // Reads that began before this change aren't kept, nor answers made from them.
  await bumpGeneration(tx, orgId);
  await tx.execute(sql`
    delete from app.dashboard_result where org_id = ${orgId}
      and (cache_key like 'svc:%' or (cache_key not like 'svc%' and result ? 'service'))`);
}

/**
 * The workspace's service generation, moved by each change (and each account refused). `hold`: held for share until
 * the transaction ends, so a change waits for what's being kept under it.
 */
export async function serviceGeneration(tx: TenantTx, orgId: string, hold = false): Promise<string> {
  if (hold) {
    await tx.execute(sql`
      insert into app.dashboard_result (org_id, cache_key, status, result, expires_at)
      values (${orgId}, ${GENERATION}, 'ok', ${JSON.stringify({ at: "" })}::jsonb, 'infinity')
      on conflict (org_id, cache_key) do nothing`);
  }
  const [row] = await tx.execute<{ at: string | null }>(
    hold
      ? sql`select result->>'at' as at from app.dashboard_result
          where org_id = ${orgId} and cache_key = ${GENERATION} for share`
      : sql`select result->>'at' as at from app.dashboard_result where org_id = ${orgId} and cache_key = ${GENERATION}`,
  );
  return row?.at ?? "";
}

/** One read of a service, recorded as a query_run (engine mcp): who it read as, what it called, how it went; never its rows. */
async function insertServiceRun(
  tx: TenantTx,
  r: {
    id: string;
    orgId: string;
    dashboardId: string;
    ds: ServiceDataset;
    reader: string;
    scope: "personal" | "org";
    key: string;
    durationMs: number;
    ok: boolean;
    error?: string;
    rows?: number;
    incomplete?: boolean;
    server?: string;
    extra?: object;
  },
): Promise<string> {
  const args = createHash("sha256").update(stable(r.ds.service.arguments)).digest("hex").slice(0, 16);
  const described = `-- mcp ${r.ds.service.tool} (arguments ${args})`;
  await tx.execute(sql`
      insert into app.query_run (id, org_id, connection_id, requester_type, requester_id, mode, path, engine, title,
        compiled_sql, sql_hash, status, error, rows, truncated, duration_ms, semantic, cache_key)
      values (${r.id}, ${r.orgId}, ${r.ds.connection}, 'dashboard', ${r.dashboardId}, 'execute', 'mcp', 'mcp',
        ${`${r.server || "Service"} · ${r.ds.service.tool}`.slice(0, 200)}, ${described},
        ${createHash("sha256").update(described).digest("hex")}, ${r.ok ? "succeeded" : "failed"},
        ${r.error ? JSON.stringify({ message: r.error }) : null}::jsonb, ${r.rows ?? null}, ${r.incomplete ?? false},
        ${r.durationMs},
        ${JSON.stringify({
          mcp: {
            tool: r.ds.service.tool,
            arguments: args,
            scope: r.scope,
            reader: r.reader,
            snapshot: r.id,
            complete: r.ok ? !r.incomplete : null,
            ...(r.extra ?? {}),
          },
        })}::jsonb,
        ${r.key})`);
  return r.id;
}

/**
 * Runs a query compiled against `serviceCatalog` over its snapshot, in this database: the compiled SQL's `$n`
 * parameters and the snapshot are bound, nothing is written into the statement, and it reads no table.
 */
export async function runOnSnapshot(
  tx: TenantTx,
  compiled: CompiledQuery,
  snapshot: Snapshot,
): Promise<Record<string, unknown>[]> {
  // No identifier holds a "$" (names are plain), and no value is ever written into the statement: every "$" here is
  // a parameter, or the snapshot.
  const marker = /\$(\d+)|\$od_snapshot\$/g;
  const out: SQL[] = [];
  let last = 0;
  for (const m of compiled.sql.matchAll(marker)) {
    out.push(sql.raw(compiled.sql.slice(last, m.index)));
    if (m[1] === undefined) out.push(sql`${sql.param(JSON.stringify(snapshot.rows))}`);
    else {
      const p = compiled.params[Number(m[1]) - 1];
      if (!p) throw new Error("A parameter is missing.");
      out.push(sql`${sql.param(p.value)}`);
    }
    last = m.index + m[0].length;
  }
  out.push(sql.raw(compiled.sql.slice(last)));
  await tx.execute(sql`set local statement_timeout = 5000`);
  return tx.execute<Record<string, unknown>>(sql.join(out, sql``));
}

export { isServiceDataset };

/**
 * A service dataset checked when it's saved: the call run once now as the person saving it (the dashboard's owner),
 * through the one executor, its answer shaped as declared. Refused when it can't run in a dashboard, when the answer
 * has no records where it says, or when a column matches nothing or never reads as its type. Gives the tool's digest
 * as it is now, which the dataset keeps: a later change to the tool stops it until it's checked again.
 */
export async function probeServiceDataset(
  deps: { withTenant: <T>(orgId: string, fn: (tx: TenantTx) => Promise<T>) => Promise<T>; mcp?: McpDeps },
  input: { orgId: string; owner: string; name: string; ds: ServiceDataset; signal?: AbortSignal },
): Promise<{ ok: true; digest: string; rows: number; sample: Shaped["rows"] } | { ok: false; message: string }> {
  if (!deps.mcp) return { ok: false, message: "Services aren't set up on this server." };
  // As the owner: row security shows a person's own connection only in a transaction that carries them.
  const now_ = await deps.mcp.withTenant({ orgId: input.orgId, userId: input.owner }, (tx) =>
    serviceNow(
      tx,
      input.orgId,
      { ...input.ds, service: { ...input.ds.service, digest: undefined } },
      { owner: input.owner, asker: input.owner },
    ),
  );
  if (!now_.ok) return { ok: false, message: now_.refused };
  const outcome = await callTool(
    deps.mcp,
    { orgId: input.orgId, userId: input.owner },
    {
      serverId: input.ds.connection,
      tool: input.ds.service.tool,
      arguments: input.ds.service.arguments,
      via: "dashboard",
      policy: { readsOnly: true },
      ...(input.signal ? { signal: input.signal } : {}),
    },
  );
  if (outcome.state !== "ready") {
    return {
      ok: false,
      message:
        outcome.state === "blocked" ? outcome.message : `${outcome.server.name} can't be read now (${outcome.state}).`,
    };
  }
  let shaped: Shaped;
  try {
    shaped = shapeRows(outcome.result as ToolAnswer, input.ds);
  } catch (error) {
    if (error instanceof ShapeProblem) return { ok: false, message: error.message };
    throw error;
  }
  if (!shaped.rows.length) {
    return { ok: false, message: "The call returned no records: change its arguments so it returns some to check." };
  }
  if (shaped.missing.length) {
    return { ok: false, message: `Nothing in its answer is at the path of ${shaped.missing.join(", ")}.` };
  }
  const never = Object.entries(shaped.unread)
    .filter(([, n]) => n === shaped.rows.length)
    .map(([c]) => c);
  if (never.length) {
    return {
      ok: false,
      message: `${never.join(", ")} never read as ${never.length === 1 ? "its type" : "their types"}.`,
    };
  }
  const [tool] = await deps.withTenant(input.orgId, (tx) =>
    tx.execute<{ digest: string }>(sql`
      select digest from app.mcp_tool
      where org_id = ${input.orgId} and server_id = ${input.ds.connection} and name = ${input.ds.service.tool}`),
  );
  return { ok: true, digest: tool?.digest ?? "", rows: shaped.rows.length, sample: shaped.rows.slice(0, 3) };
}

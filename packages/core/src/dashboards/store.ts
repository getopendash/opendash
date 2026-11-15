/**
 * Dashboards' storage and the operations on it, shared by the API and the analyst's tools. A dashboard has
 * saved versions, never changed once written (a trigger refuses it), and one draft its owner builds in. Each version
 * and the draft carry their render revision; a frame names the revision it draws, and only a revision someone may
 * read answers (a version for anyone who reads the dashboard, the draft for those who may change it).
 *
 * Visibility is a conversation's (private, the project's people, the organization's), checked in SQL the way threads
 * are (`dashboardReadableBy`), and people may be added by name on top of it (`dashboard_share`), each to view it or to
 * edit its draft. The draft is changed by its owner and its editors (`dashboardEditableBy`); publishing, restoring,
 * sharing and deleting stay its owner's.
 */
import { checkDefinition, Definition, isServiceDataset, type Problem } from "@opendash/apps/dashboard";
import { revisionOf } from "@opendash/apps/dashboard/revision";
import { oversize } from "@opendash/apps/limits";
import type { Catalog } from "@opendash/apps/protocol";
import { RUNTIME_HASH } from "@opendash/apps/runtime-bundle";
import { isUuid, sql, type TenantTx, uuidv7 } from "@opendash/db";
import { dashboardEditableBy, dashboardReadableBy, dashboardShareOf, threadReadableBy } from "../projects/access";

import { dashboardCatalog, pinsOf, unresolved, withOwn } from "./catalog";
import { serviceNow } from "./service";

export class DashboardProblem extends Error {
  override name = "DashboardProblem";
  constructor(
    readonly code: "not_found" | "not_yours" | "invalid" | "conflict",
    message: string,
  ) {
    super(message);
  }
}

/** Who acts: a person in an organization. */
export interface Actor {
  orgId: string;
  userId: string;
}

/** An App's code, checked and bundled (the App's code check). */
export interface PartsBuild {
  files: Record<string, string>;
  bundle: string;
  bundleHash: string;
}

export interface DashboardVersionView {
  version: number;
  definition: Definition;
  revision: string;
  bundleHash: string | null;
  runtimeHash: string;
  authorId: string | null;
  changeNote: string | null;
  createdAt: string;
  /** What it read unreleased when it was published, by item id: the versions it reads (its labels too). */
  pins: Record<string, number>;
}

export interface DashboardView {
  id: string;
  title: string;
  purpose: string | null;
  ownerId: string;
  mine: boolean;
  /** Its owner, or someone it's shared with to edit: they change its draft (publishing stays its owner's). */
  canEdit: boolean;
  /** How it's shared with the viewer by name ('view', 'edit'), or null: they read it as its owner or by visibility. */
  sharedRole: ShareRole | null;
  /** For its owner: how many people it's shared with by name, and how many of them to edit. */
  people: number;
  editors: number;
  visibility: "private" | "project" | "org";
  projectId: string | null;
  threadId: string | null;
  currentVersion: number;
  updatedAt: string;
  /** The version people open; null while it's a draft being built. */
  version: DashboardVersionView | null;
  /** For those who change it: the plan it was built from (its pages drawn as outlines until each lands). */
  plan: unknown | null;
  /** The draft, for its owner and its editors alone, with who last saved it (its actions are off for anyone else). */
  draft: {
    definition: Definition;
    revision: string | null;
    bundleHash: string | null;
    baseVersion: number;
    savedBy: string;
  } | null;

  /** For those who change it: a run working on it now (building or changing it), with when it began. */
  building: { runId: string; startedAt: string } | null;
}

/** What a person a dashboard is shared with may do: read it, or change its draft too. */
export type ShareRole = "view" | "edit";

/** A new dashboard, its owner's, private until they share it: a draft is built in it next. */
export async function createDashboard(
  tx: TenantTx,
  actor: Actor,
  input: { title: string; purpose?: string | null; projectId?: string | null; threadId?: string | null },
): Promise<string> {
  const title = input.title.trim().slice(0, 120);
  if (!title) throw new DashboardProblem("invalid", "Give it a title.");
  const id = uuidv7();
  await tx.execute(sql`
    insert into app.dashboard (org_id, id, title, purpose, owner_id, project_id, thread_id)
    values (${actor.orgId}, ${id}, ${title}, ${input.purpose?.trim().slice(0, 300) || null}, ${actor.userId},
      ${input.projectId ?? null}, ${input.threadId ?? null})`);
  return id;
}

/**
 * The dashboard a plan is built into, made the moment its person presses Build it: titled from the plan,
 * the plan kept on it (its page draws the plan's pages as outlines until each lands), in their conversation. One a
 * plan: starting again from the same plan (a second press, a replayed call) finds the one it made.
 */
export async function startDashboard(
  tx: TenantTx,
  actor: Actor,
  input: {
    threadId: string;
    planRunId: string;
    plan: { title: string; purpose?: string | null } & Record<string, unknown>;
  },
): Promise<{ id: string; made: boolean }> {
  const title = input.plan.title.trim().slice(0, 120);
  if (!title) throw new DashboardProblem("invalid", "Give it a title.");
  const [made] = await tx.execute<{ id: string }>(sql`
    insert into app.dashboard (org_id, id, title, purpose, owner_id, thread_id, plan, plan_run_id)
    values (${actor.orgId}, ${uuidv7()}, ${title}, ${input.plan.purpose?.trim().slice(0, 300) || null}, ${actor.userId},
      ${input.threadId}, ${JSON.stringify(input.plan)}::jsonb, ${input.planRunId})
    on conflict (org_id, plan_run_id) where plan_run_id is not null do nothing
    returning id`);
  if (made) return { id: made.id, made: true };
  const [had] = await tx.execute<{ id: string }>(sql`
    select id from app.dashboard
    where org_id = ${actor.orgId} and plan_run_id = ${input.planRunId} and owner_id = ${actor.userId}
      and deleted_at is null`);
  if (!had) throw new DashboardProblem("invalid", "That plan's dashboard was deleted: plan it again.");
  return { id: had.id, made: false };
}

/** The catalogs of the sources a definition names, by connection id (only this organization's sources). */
export async function catalogsFor(
  tx: TenantTx,
  orgId: string,
  definition: unknown,
  /** A published version's pins: its labels read what it reads. */
  pins: Record<string, number> = {},
): Promise<Record<string, Catalog>> {
  const parsed = Definition.safeParse(definition);
  const connections = parsed.success
    ? [...new Set(Object.values(parsed.data.queries).map((q) => q.source.connection))]
    : [];
  const out: Record<string, Catalog> = {};
  for (const c of connections) {
    const loaded = await dashboardCatalog(tx, orgId, c, pins);
    if (loaded) out[c] = loaded.catalog;
  }
  return out;
}

/**
 * The dashboard, locked, when this person may do what's asked: `owner` for what stays its owner's (publish, restore,
 * share), `edit` for a change to its draft (its owner, or someone it's shared with to edit). One they can't read isn't
 * there for them.
 */
async function locked(tx: TenantTx, actor: Actor, dashboardId: string, need: "owner" | "edit") {
  const [d] = isUuid(dashboardId)
    ? await tx.execute<{ owner_id: string; current_version: number; can_edit: boolean }>(sql`
        select d.owner_id, d.current_version, ${dashboardEditableBy(actor.userId)} as can_edit from app.dashboard d
        where d.org_id = ${actor.orgId} and d.id = ${dashboardId} and d.deleted_at is null
          and ${dashboardReadableBy(actor.userId)}
        for update of d`)
    : [];
  if (!d) throw new DashboardProblem("not_found", "That dashboard isn't here.");
  if (need === "owner" && d.owner_id !== actor.userId) {
    throw new DashboardProblem("not_yours", "Only its owner publishes, restores or shares a dashboard.");
  }
  if (need === "edit" && !d.can_edit) {
    throw new DashboardProblem("not_yours", "Only its owner, or someone it's shared with to edit, changes it.");
  }
  return d;
}
const owned = (tx: TenantTx, actor: Actor, dashboardId: string) => locked(tx, actor, dashboardId, "owner");
const editable = (tx: TenantTx, actor: Actor, dashboardId: string) => locked(tx, actor, dashboardId, "edit");

/** Whether the person may change the dashboard's draft: its owner, or someone it's shared with to edit. */
export async function canEditDashboard(
  tx: TenantTx,
  viewer: { orgId: string; userId: string | null },
  dashboardId: string,
): Promise<boolean> {
  if (!viewer.userId || !isUuid(dashboardId)) return false;
  const [d] = await tx.execute<{ id: string }>(sql`
    select d.id from app.dashboard d
    where d.org_id = ${viewer.orgId} and d.id = ${dashboardId} and d.deleted_at is null
      and ${dashboardEditableBy(viewer.userId)}`);
  return Boolean(d);
}

/**
 * A query's row actions, as the workspace has them now: each names an approved server's tool that changes things (a
 * tool that only reads isn't an action). Whether it may run from an App, and as whom, is checked when it's pressed.
 */
async function actionProblems(tx: TenantTx, orgId: string, d: Definition): Promise<Problem[]> {
  const problems: Problem[] = [];
  const declared = Object.entries(d.queries).flatMap(([qid, q]) =>
    (q.actions ?? []).map((a, ai) => ({ a, path: `queries.${qid}.actions[${ai}]` })),
  );
  for (const { a, path } of declared) {
    const [tool] = await tx.execute<{ server: string; access: string; read_only: boolean; status: string }>(sql`
          select s.name as server, s.access, t.status,
            coalesce((t.annotations->>'readOnlyHint')::boolean, false) as read_only
          from app.mcp_server s join app.mcp_tool t on t.org_id = s.org_id and t.server_id = s.id and t.name = ${a.tool}
          where s.org_id = ${orgId} and s.id = ${a.connection}`);
    if (!tool || tool.status === "removed") {
      problems.push({ path: `${path}.tool`, message: `There's no ${a.tool} on that connection.` });
    } else if (tool.read_only) {
      problems.push({
        path: `${path}.tool`,
        message: `${tool.server}'s ${a.tool} only reads: an action changes something.`,
      });
    } else if (tool.access !== "personal") {
      problems.push({
        path: `${path}.connection`,
        message: `${tool.server} is connected once for the workspace: a change is made by a person with their own account.`,
      });
    }
  }
  return problems;
}

/**
 * Saves the draft: checked whole (its shape, every reference, the datasets it names), with its render
 * revision. A draft that doesn't pass isn't saved; its problems say where. It names the version its change began from:
 * a change begun on an older version (another tab, a restore since) is refused, never written over the newer one.
 * A change that began from a working copy (the analyst's, read with `workingCopy`) names when that draft was saved
 * too, or null for none: a draft saved since (a parallel save, even one that renders the same) is refused, never
 * written over.
 */
export async function saveDraft(
  tx: TenantTx,
  actor: Actor,
  dashboardId: string,
  input: {
    definition: unknown;
    parts?: PartsBuild | null;
    baseVersion: number;
    baseDraftAt?: string | null;
    /** The analyst's run saving it: what it saves can be undone. A person's own save clears that. */
    runId?: string | null;
  },
): Promise<{ ok: true; revision: string } | { ok: false; problems: Problem[] }> {
  const d = await editable(tx, actor, dashboardId);
  const [had] = await tx.execute<{
    base_version: number;
    saved_at: string;
    definition: unknown;
    parts: unknown;
    bundle: string | null;
    bundle_hash: string | null;
    runtime_hash: string | null;
    revision: string | null;
    undo: DraftUndo | null;
    saved_by: string | null;
  }>(sql`
    select base_version, updated_at::text as saved_at, definition, parts, bundle, bundle_hash, runtime_hash, revision,
      undo, updated_by as saved_by
    from app.dashboard_draft
    where org_id = ${actor.orgId} and dashboard_id = ${dashboardId}`);
  if ((had?.base_version ?? d.current_version) !== input.baseVersion) {
    throw new DashboardProblem("conflict", "It changed since this change began. Open it again and redo the change.");
  }
  if (input.baseDraftAt !== undefined && (had?.saved_at ?? null) !== input.baseDraftAt) {
    throw new DashboardProblem("conflict", "Its draft was saved again since this change began. Open it and redo it.");
  }
  const checked = checkDefinition(input.definition, {
    catalogs: await catalogsFor(tx, actor.orgId, input.definition),
  });
  if (!checked.ok) return checked;
  const unusable = await actionProblems(tx, actor.orgId, checked.definition);
  if (unusable.length) return { ok: false, problems: unusable };
  // An editor's draft reads only what the editor can read themselves: its code runs in
  // its owner's frame when they open it, so a service the editor can't read isn't one it may name. Each service is
  // checked as it would be read, as the editor. A source of the workspace is everyone's to read alike.
  if (d.owner_id !== actor.userId) {
    const unreadable: Problem[] = [];
    for (const [name, ds] of Object.entries(checked.definition.datasets ?? {})) {
      if (!isServiceDataset(ds)) continue;
      const now = await serviceNow(tx, actor.orgId, ds, { owner: d.owner_id, asker: actor.userId });
      if (!now.ok) unreadable.push({ path: `datasets.${name}`, message: `You can't read it yourself: ${now.refused}` });
    }
    if (unreadable.length) return { ok: false, problems: unreadable };
  }
  const parts = input.parts ?? null;
  const revision = revisionOf({
    definition: checked.definition,
    bundleHash: parts?.bundleHash ?? null,
    runtimeHash: RUNTIME_HASH,
  });
  // A run's first save of it keeps what was there (a draft, or none: the version); its later saves keep that and move
  // on what it last saved. A save that isn't a run's (the person's own) ends what a run could undo.
  const undo: DraftUndo | null = input.runId
    ? had?.undo?.runId === input.runId
      ? { ...had.undo, after: revision }
      : {
          runId: input.runId,
          version: d.current_version,
          after: revision,
          before: had?.revision
            ? {
                definition: had.definition,
                parts: had.parts,
                bundle: had.bundle,
                bundleHash: had.bundle_hash,
                runtimeHash: had.runtime_hash,
                revision: had.revision,
                baseVersion: had.base_version,
                savedBy: had.saved_by,
              }
            : null,
        }
    : null;
  await tx.execute(sql`
    insert into app.dashboard_draft
      (org_id, dashboard_id, definition, parts, bundle, bundle_hash, runtime_hash, revision, base_version, updated_by,
        undo)
    values (${actor.orgId}, ${dashboardId}, ${JSON.stringify(checked.definition)}::jsonb,
      ${JSON.stringify(parts?.files ?? {})}::jsonb, ${parts?.bundle ?? null}, ${parts?.bundleHash ?? null},
      ${RUNTIME_HASH}, ${revision}, ${input.baseVersion}, ${actor.userId}, ${undo ? JSON.stringify(undo) : null}::jsonb)
    on conflict (org_id, dashboard_id) do update set definition = excluded.definition, parts = excluded.parts,
      bundle = excluded.bundle, bundle_hash = excluded.bundle_hash, runtime_hash = excluded.runtime_hash,
      revision = excluded.revision, updated_by = excluded.updated_by, updated_at = now(), undo = excluded.undo,
      render_check = null`);
  // What didn't build before is built now.
  await tx.execute(sql`update app.dashboard set work = null where org_id = ${actor.orgId} and id = ${dashboardId}`);
  return { ok: true, revision };
}

/** What the render check found at one width (apps as code): a finding is a kind and its words. */
export interface RenderFinding {
  kind: "overflow" | "overlap" | "clipped" | "empty" | "failed" | "error" | "speed";
  message: string;
}
export interface RenderCheck {
  revision: string;
  /** By width in pixels: what was found there, and whether its answers had settled. */
  widths: Record<string, { findings: RenderFinding[]; unsettled?: boolean; at: string }>;
}
const RENDER_KINDS = new Set(["overflow", "overlap", "clipped", "empty", "failed", "error", "speed"]);

/**
 * Keeps what the browser of someone who changes it (its owner, an editor) measured of the draft at one width (the
 * render check): only for the revision the draft holds now (a measurement of an older one is dropped), each finding
 * cut to its kind and 300 characters, at most 20 a width and three widths.
 */
export async function saveRenderCheck(
  tx: TenantTx,
  actor: Actor,
  dashboardId: string,
  input: { revision: string; width: number; findings: unknown[]; unsettled?: boolean },
): Promise<boolean> {
  await editable(tx, actor, dashboardId);
  const width = Math.round(input.width);
  if (!Number.isFinite(width) || width < 200 || width > 4000) return false;
  const findings: RenderFinding[] = input.findings
    .flatMap((f) => {
      const o = (f ?? {}) as { kind?: unknown; message?: unknown };
      return typeof o.kind === "string" && RENDER_KINDS.has(o.kind) && typeof o.message === "string"
        ? [{ kind: o.kind as RenderFinding["kind"], message: o.message.slice(0, 300) }]
        : [];
    })
    .slice(0, 20);
  const entry = { findings, ...(input.unsettled ? { unsettled: true } : {}), at: new Date().toISOString() };
  // Read and written under the draft's row lock, only while it still holds this revision, and only by whoever saved
  // it: the check runs that person's code, and what it measured is kept where they read it. Measured in someone else's
  // browser, it could carry what that person's own data drew back to the code's author.
  const [draft] = await tx.execute<{ check: RenderCheck | null }>(sql`
    select r.render_check as check from app.dashboard_draft r
    join app.dashboard d on d.org_id = r.org_id and d.id = r.dashboard_id
    where r.org_id = ${actor.orgId} and r.dashboard_id = ${dashboardId} and r.revision = ${input.revision}
      and ${SAVED_BY} = ${actor.userId}::uuid
    for update of r`);
  if (!draft) return false;
  const widths = draft.check?.revision === input.revision ? { ...draft.check.widths } : {};
  if (!(String(width) in widths) && Object.keys(widths).length >= 3) return false;
  widths[String(width)] = entry;
  const check: RenderCheck = { revision: input.revision, widths };
  await tx.execute(sql`
    update app.dashboard_draft set render_check = ${JSON.stringify(check)}::jsonb
    where org_id = ${actor.orgId} and dashboard_id = ${dashboardId} and revision = ${input.revision}`);
  return true;
}

/** The render check of the draft as it is now (its revision's), or null when none has been measured. */
export async function renderCheckOf(tx: TenantTx, actor: Actor, dashboardId: string): Promise<RenderCheck | null> {
  await editable(tx, actor, dashboardId);
  const [row] = await tx.execute<{ check: RenderCheck | null; revision: string | null }>(sql`
    select render_check as check, revision from app.dashboard_draft
    where org_id = ${actor.orgId} and dashboard_id = ${dashboardId}`);
  if (!row?.check || row.check.revision !== row.revision) return null;
  return row.check;
}

/** What an analyst's run can put back of a draft: see `dashboard_draft.undo`. */
export interface DraftUndo {
  runId: string;
  /** The dashboard's version when the run first saved: a publish since means there's nothing to put back. */
  version: number;
  /** The revision the run last saved: a save over it since (the person's, another run's) means none either. */
  after: string;
  before: {
    definition: unknown;
    parts: unknown;
    bundle: string | null;
    bundleHash: string | null;
    runtimeHash: string | null;
    revision: string;
    baseVersion: number;
    /** Who had saved it (its `updated_by`): put back, it's theirs again. Absent on undos kept before shares. */
    savedBy?: string | null;
  } | null;
}

/**
 * Which of these dashboards a run's change can still be undone on (those the person changes: theirs, or shared with
 * them to edit): the run's last save is still the draft and nothing was published since. What "Undo these changes" is
 * offered for; undoRun checks the same again.
 */
export async function undoable(tx: TenantTx, actor: Actor, dashboardIds: string[], runId: string): Promise<string[]> {
  const ids = dashboardIds.filter(isUuid).slice(0, 20);
  if (!ids.length) return [];
  const rows = await tx.execute<{ id: string }>(sql`
    select d.id from app.dashboard d
    join app.dashboard_draft x on x.org_id = d.org_id and x.dashboard_id = d.id
    where d.org_id = ${actor.orgId} and ${dashboardEditableBy(actor.userId)} and d.deleted_at is null
      and d.id in (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
      and x.undo->>'runId' = ${runId} and x.revision = x.undo->>'after'
      and d.current_version = (x.undo->>'version')::int`);
  return rows.map((r) => r.id);
}

/**
 * Puts back what an analyst's run changed in a draft ("Undo these changes"): the draft as it was before
 * the run's first save, or no draft (the published version shows again). Its owner's or an editor's, and only while
 * the run's last save is still the draft and nothing was published since: otherwise it's refused, never written over
 * newer work.
 */
export async function undoRun(
  tx: TenantTx,
  actor: Actor,
  dashboardId: string,
  runId: string,
): Promise<{ revision: string | null }> {
  const d = await editable(tx, actor, dashboardId);
  const [draft] = await tx.execute<{ revision: string | null; undo: DraftUndo | null }>(sql`
    select revision, undo from app.dashboard_draft
    where org_id = ${actor.orgId} and dashboard_id = ${dashboardId}
    for update`);
  const undo = draft?.undo;
  if (!undo || undo.runId !== runId || draft.revision !== undo.after || d.current_version !== undo.version) {
    throw new DashboardProblem("conflict", "It changed since: there's nothing of this change left to undo.");
  }
  const b = undo.before;
  if (!b) {
    await tx.execute(
      sql`delete from app.dashboard_draft where org_id = ${actor.orgId} and dashboard_id = ${dashboardId}`,
    );
    return { revision: null };
  }
  // A draft kept from before migration 0106 still carries the kit's empty pages and nav, which an App's schema refuses
  // now: they go as it's put back, and its revision is the one of what's written.
  const definition = withoutRetiredKeys(b.definition);
  const revision =
    definition === b.definition
      ? b.revision
      : revisionOf({ definition, bundleHash: b.bundleHash, runtimeHash: b.runtimeHash ?? RUNTIME_HASH });
  // Put back, the draft is whoever saved it then's (an editor's code stays theirs, whoever presses Undo); an undo kept
  // before drafts had editors was its owner's.
  await tx.execute(sql`
    update app.dashboard_draft set definition = ${JSON.stringify(definition)}::jsonb,
      parts = ${JSON.stringify(b.parts ?? {})}::jsonb, bundle = ${b.bundle}, bundle_hash = ${b.bundleHash},
      runtime_hash = ${b.runtimeHash}, revision = ${revision}, base_version = ${b.baseVersion},
      updated_by = ${b.savedBy ?? d.owner_id}, updated_at = now(), undo = null
    where org_id = ${actor.orgId} and dashboard_id = ${dashboardId}`);
  return { revision };
}

/**
 * An App's definition without the keys the kit's schema had and an App's refuses (`pages`, `nav`), the same object
 * when it has neither. Migration 0106 took them out of drafts and versions; copies of a definition kept elsewhere (a
 * run's undo, work that didn't build) can still hold them, so they're taken out where such a copy is used again.
 */
export function withoutRetiredKeys(definition: unknown): unknown {
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) return definition;
  const d = definition as Record<string, unknown>;
  if (d.version !== 2 || !(Object.hasOwn(d, "pages") || Object.hasOwn(d, "nav"))) return definition;
  const { pages: _pages, nav: _nav, ...rest } = d;
  return rest;
}

/**
 * The draft becomes the next version: the draft the person saw (its revision), against the version it was based on.
 * A draft changed since (another tab saved over it) or begun before another publish is refused, never published in
 * its place. Its title follows the definition's.
 */
export async function publishDraft(
  tx: TenantTx,
  actor: Actor,
  dashboardId: string,
  input: { revision: string; note?: string | null; runId?: string | null },
): Promise<{ version: number; revision: string }> {
  const d = await owned(tx, actor, dashboardId);
  const [draft] = await tx.execute<{
    definition: Definition;
    parts: Record<string, string>;
    bundle: string | null;
    bundle_hash: string | null;
    runtime_hash: string | null;
    revision: string | null;
    base_version: number;
  }>(sql`
    select definition, parts, bundle, bundle_hash, runtime_hash, revision, base_version from app.dashboard_draft
    where org_id = ${actor.orgId} and dashboard_id = ${dashboardId}`);
  if (!draft?.revision || !draft.runtime_hash)
    throw new DashboardProblem("invalid", "There's no checked draft to save.");
  if (draft.revision !== input.revision) {
    throw new DashboardProblem("conflict", "The draft changed since you looked at it. Look again, then save.");
  }
  if (draft.base_version !== d.current_version) {
    throw new DashboardProblem("conflict", "It changed since this draft began. Open it again and redo the change.");
  }
  // An App is its code: a draft saved before its page (the manifest first is a step of a build) is kept as a draft,
  // never published, since a version without a bundle would leave everyone who opens it waiting on nothing.
  if (!Object.hasOwn(draft.parts ?? {}, "/App.tsx") || !draft.bundle || !draft.bundle_hash) {
    throw new DashboardProblem(
      "invalid",
      "It has no page yet: its /App.tsx isn't written or doesn't build. Publish once its page is saved.",
    );
  }
  const version = d.current_version + 1;
  // What it reads that isn't released yet, pinned at the version it reads now. Everything it reads must be there now
  // (released, or checked): a definition being edited, its checks not done, is waited for, never published past.
  const pins: Record<string, number> = {};
  const services = new Set(
    Object.values(draft.definition.datasets ?? {}).flatMap((ds) => (isServiceDataset(ds) ? [ds.connection] : [])),
  );
  for (const c of new Set(Object.values(draft.definition.queries).map((q) => q.source.connection))) {
    // A service is checked on every request instead (service.ts): there's no catalog to pin.
    if (services.has(c)) continue;
    const loaded = await dashboardCatalog(tx, actor.orgId, c);
    if (!loaded) throw new DashboardProblem("invalid", "A source it reads is gone.");
    const missing = unresolved(draft.definition, withOwn(loaded, draft.definition));
    if (missing.length) {
      throw new DashboardProblem(
        "invalid",
        `${missing.join(", ")} ${missing.length === 1 ? "isn't" : "aren't"} checked right now (changed since this draft, or its checks are still running): publish once ${missing.length === 1 ? "it is" : "they are"}.`,
      );
    }
    Object.assign(pins, pinsOf(draft.definition, loaded));
  }
  // The same content as the current version changes nothing. An earlier version's content (a restore) is a new
  // version drawing that revision again.
  const [same] = await tx.execute<{ version: number }>(sql`
    select version from app.dashboard_version
    where org_id = ${actor.orgId} and dashboard_id = ${dashboardId} and version = ${d.current_version}
      and revision = ${draft.revision}`);
  if (same) throw new DashboardProblem("conflict", `That's version ${same.version} as it is: nothing changed.`);
  await tx.execute(sql`
    insert into app.dashboard_version (org_id, dashboard_id, version, definition, parts, bundle, bundle_hash,
      runtime_hash, revision, author_id, run_id, parent_version, change_note, pins)
    values (${actor.orgId}, ${dashboardId}, ${version}, ${JSON.stringify(draft.definition)}::jsonb,
      ${JSON.stringify(draft.parts)}::jsonb, ${draft.bundle}, ${draft.bundle_hash}, ${draft.runtime_hash},
      ${draft.revision}, ${actor.userId}, ${input.runId ?? null}, ${d.current_version || null},
      ${input.note?.trim().slice(0, 300) || null},
      ${Object.keys(pins).length ? JSON.stringify(pins) : null}::jsonb)`);
  await tx.execute(sql`
    update app.dashboard set current_version = ${version}, title = ${draft.definition.title.slice(0, 120)},
      updated_at = now()
    where org_id = ${actor.orgId} and id = ${dashboardId}`);
  await tx.execute(
    sql`delete from app.dashboard_draft where org_id = ${actor.orgId} and dashboard_id = ${dashboardId}`,
  );
  return { version, revision: draft.revision };
}

type VersionRow = {
  version: number;
  definition: Definition;
  revision: string;
  bundle_hash: string | null;
  runtime_hash: string;
  author_id: string | null;
  change_note: string | null;
  created_at: string;
  pins?: Record<string, number> | null;
};
const versionView = (v: VersionRow): DashboardVersionView => ({
  version: v.version,
  definition: v.definition,
  revision: v.revision,
  bundleHash: v.bundle_hash,
  runtimeHash: v.runtime_hash,
  authorId: v.author_id,
  changeNote: v.change_note,
  createdAt: new Date(v.created_at).toISOString(),
  pins: v.pins ?? {},
});

/** A dashboard as the viewer may see it: its current version, and its draft when they may change it. */
export async function getDashboard(
  tx: TenantTx,
  viewer: { orgId: string; userId: string | null },
  dashboardId: string,
): Promise<DashboardView | null> {
  if (!isUuid(dashboardId)) return null;
  const [d] = await tx.execute<{
    id: string;
    title: string;
    purpose: string | null;
    owner_id: string;
    visibility: DashboardView["visibility"];
    project_id: string | null;
    thread_id: string | null;
    current_version: number;
    updated_at: string;
    plan: unknown | null;
    can_edit: boolean;
    shared_role: ShareRole | null;
    people: number;
    editors: number;
  }>(sql`
    select d.id, d.title, d.purpose, d.owner_id, d.visibility, d.project_id, d.thread_id, d.current_version,
      d.updated_at, d.plan, ${dashboardEditableBy(viewer.userId)} as can_edit,
      ${dashboardShareOf(viewer.userId)} as shared_role,
      (select count(*)::int from app.dashboard_share s where s.org_id = d.org_id and s.dashboard_id = d.id) as people,
      (select count(*)::int from app.dashboard_share s
        where s.org_id = d.org_id and s.dashboard_id = d.id and s.role = 'edit') as editors
    from app.dashboard d
    where d.org_id = ${viewer.orgId} and d.id = ${dashboardId} and d.deleted_at is null
      and ${dashboardReadableBy(viewer.userId)}`);
  if (!d) return null;
  const mine = d.owner_id === viewer.userId;
  const canEdit = Boolean(d.can_edit);
  const [v] = d.current_version
    ? await tx.execute<VersionRow>(sql`
        select version, definition, revision, bundle_hash, runtime_hash, author_id, change_note, created_at, pins
        from app.dashboard_version
        where org_id = ${viewer.orgId} and dashboard_id = ${dashboardId} and version = ${d.current_version}`)
    : [];
  const [draft] = canEdit
    ? await tx.execute<{
        definition: Definition;
        revision: string | null;
        bundle_hash: string | null;
        base_version: number;
        saved_by: string;
      }>(sql`
        select r.definition, r.revision, r.bundle_hash, r.base_version, ${SAVED_BY} as saved_by
        from app.dashboard_draft r join app.dashboard d on d.org_id = r.org_id and d.id = r.dashboard_id
        where r.org_id = ${viewer.orgId} and r.dashboard_id = ${dashboardId}`)
    : [];
  // The run working on it: one in its conversation (from Build it on), or one in another conversation it's attached
  // to that has called a dashboard tool on it (an editor's, from their own).
  const [run] = canEdit
    ? await tx.execute<{ id: string; started_at: string }>(sql`
        select x.id, coalesce(x.started_at, x.queued_at)::text as started_at from app.run x
        where x.org_id = ${viewer.orgId} and x.parent_run_id is null and x.status in ('queued', 'running', 'cancelling')
          and (${d.thread_id ? sql`x.thread_id = ${d.thread_id} or ` : sql``}exists (
            select 1 from app.tool_call t
            where t.org_id = x.org_id and t.run_id = x.id and t.result->>'dashboard_id' = ${d.id}))
          -- One the viewer can follow: an editor's run in their own conversation isn't its owner's to watch, nor the
          -- owner's the editor's.
          and exists (
            select 1 from app.thread t where t.org_id = x.org_id and t.id = x.thread_id
              and ${threadReadableBy(viewer.userId)})
        order by x.queued_at desc limit 1`)
    : [];
  return {
    id: d.id,
    title: d.title,
    purpose: d.purpose,
    ownerId: d.owner_id,
    mine,
    canEdit,
    sharedRole: d.shared_role ?? null,
    people: mine ? d.people : 0,
    editors: mine ? d.editors : 0,
    visibility: d.visibility,
    projectId: d.project_id,
    threadId: d.thread_id,
    currentVersion: d.current_version,
    updatedAt: new Date(d.updated_at).toISOString(),
    version: v ? versionView(v) : null,
    plan: canEdit ? (d.plan ?? null) : null,
    draft: draft
      ? {
          definition: draft.definition,
          revision: draft.revision,
          bundleHash: draft.bundle_hash,
          baseVersion: draft.base_version,
          savedBy: draft.saved_by,
        }
      : null,
    building: run ? { runId: run.id, startedAt: new Date(run.started_at).toISOString() } : null,
  };
}

/**
 * Who last saved a draft (alias `r`, its dashboard `d`): its `updated_by`, written by every save and by Undo (the
 * saver of what's put back); a draft from before anyone saved by name is its owner's.
 */
const SAVED_BY = sql`coalesce(r.updated_by, d.owner_id)`;

/** A drawn revision, as definitionAt gives it: for a draft, who last saved it. */
export interface DrawnRevision {
  definition: Definition;
  kind: "version" | "draft";
  pins: Record<string, number>;
  /** A draft's last saver; null for a version (its owner published it: they accepted what it runs). */
  savedBy: string | null;
}

/**
 * A draft someone else last saved, for this viewer: its code is that person's and runs
 * here with this viewer's access, so nothing it asks may change anything (a record's work, a row's action in a
 * service) until the viewer saves it themselves or its owner publishes it.
 */
export const actionsOff = (at: DrawnRevision, viewer: { userId: string | null }) =>
  at.kind === "draft" && at.savedBy !== viewer.userId;

/** Said when a draft's actions are off. */
export const ACTIONS_OFF =
  "Someone else saved this draft last: its actions are off until you save it yourself or its owner publishes it.";

/**
 * The definition a frame draws, by its revision: a saved version of a dashboard the viewer reads, or its draft for
 * those who change it (its owner, its editors). Null for any other (a revision of another dashboard, a draft that
 * moved on, one they can't read, a share since removed).
 */
export async function definitionAt(
  tx: TenantTx,
  viewer: { orgId: string; userId: string | null },
  dashboardId: string,
  revision: string,
): Promise<DrawnRevision | null> {
  if (!isUuid(dashboardId) || !/^[0-9a-f]{64}$/.test(revision)) return null;
  const [row] = await tx.execute<{
    definition: Definition;
    kind: "version" | "draft";
    pins: Record<string, number> | null;
    saved_by: string | null;
  }>(sql`
    (select v.definition, 'version' as kind, v.pins, null::uuid as saved_by from app.dashboard d
    join app.dashboard_version v on v.org_id = d.org_id and v.dashboard_id = d.id
    where d.org_id = ${viewer.orgId} and d.id = ${dashboardId} and d.deleted_at is null and v.revision = ${revision}
      and ${dashboardReadableBy(viewer.userId)}
    -- Versions sharing a revision (a restore) differ only in their pins: the current one's, else the newest.
    order by v.version = d.current_version desc, v.version desc limit 1)
    union all
    select r.definition, 'draft' as kind, null as pins, ${SAVED_BY} as saved_by from app.dashboard d
    join app.dashboard_draft r on r.org_id = d.org_id and r.dashboard_id = d.id
    where d.org_id = ${viewer.orgId} and d.id = ${dashboardId} and d.deleted_at is null and r.revision = ${revision}
      and ${dashboardEditableBy(viewer.userId)}
    limit 1`);
  return row
    ? { definition: row.definition, kind: row.kind, pins: row.pins ?? {}, savedBy: row.saved_by ?? null }
    : null;
}

export interface DashboardSummary {
  id: string;
  title: string;
  purpose: string | null;
  ownerId: string;
  mine: boolean;
  /** Its owner, or someone it's shared with to edit. */
  canEdit: boolean;
  /** How it's shared with the viewer by name, or null ("Shared with you" when it is). */
  sharedRole: ShareRole | null;
  visibility: DashboardView["visibility"];
  projectId: string | null;
  currentVersion: number;
  /** It has a draft not yet published (told to those who change it alone). */
  draft: boolean;
  /** The analyst is working on it now (told to those who change it alone). */
  building: boolean;
  updatedAt: string;
}

/** A plan for a new dashboard its asker hasn't built yet: it waits in the list, as planned. */
export interface PlannedDashboard {
  threadId: string;
  runId: string;
  title: string;
  purpose: string | null;
  plannedAt: string;
}

/**
 * The viewer's own plans for a new dashboard that nothing was built from yet: the latest in each of their conversations
 * from the last fortnight, the conversation still there. "Build it" is in the conversation, where the plan is.
 */
export async function plannedDashboards(
  tx: TenantTx,
  viewer: { orgId: string; userId: string | null },
): Promise<PlannedDashboard[]> {
  if (!viewer.userId) return [];
  const rows = await tx.execute<{
    thread_id: string;
    run_id: string;
    title: string | null;
    purpose: string | null;
    planned_at: string;
    queued_at: string;
  }>(sql`
    select * from (
      select distinct on (r.thread_id) r.thread_id, r.id as run_id, r.outcome->>'title' as title,
        r.outcome->>'purpose' as purpose, coalesce(r.finished_at, r.queued_at)::text as planned_at, r.queued_at
      from app.run r
      join app.thread t on t.org_id = r.org_id and t.id = r.thread_id
      where r.org_id = ${viewer.orgId} and t.created_by = ${viewer.userId} and t.deleted_at is null
        and r.parent_run_id is null and r.status = 'succeeded'
        and r.outcome->>'kind' = 'dashboard_plan' and r.outcome->>'dashboardId' is null
        and r.queued_at > now() - interval '14 days'
      order by r.thread_id, r.queued_at desc
    ) latest
    -- Nothing built from it: no dashboard made from that plan (Build it), nor any made in its conversation since (a
    -- whole save makes one without the plan's link). A later plan replaces it (distinct on, latest first).
    where not exists (
        select 1 from app.dashboard d where d.org_id = ${viewer.orgId}
          and (d.plan_run_id = latest.run_id or (d.thread_id = latest.thread_id and d.created_at >= latest.queued_at)))
    order by latest.queued_at desc
    limit 20`);
  return rows
    .map((x) => ({
      threadId: x.thread_id,
      runId: x.run_id,
      title: x.title ?? "A planned dashboard",
      purpose: x.purpose,
      plannedAt: new Date(x.planned_at).toISOString(),
    }))
    .sort((a, b) => b.plannedAt.localeCompare(a.plannedAt));
}

/**
 * The dashboards the viewer reads, most recently changed first: theirs and those shared with them to edit (drafts
 * being built included), and the others they read once published. With a conversation, only those built in it.
 */
export async function listDashboards(
  tx: TenantTx,
  viewer: { orgId: string; userId: string | null },
  /** A conversation's: made in it, and (`alsoIds`) ones attached to it. */
  filter: { threadId?: string; alsoIds?: string[] } = {},
): Promise<DashboardSummary[]> {
  if (filter.threadId !== undefined && !isUuid(filter.threadId)) return [];
  const also = (filter.alsoIds ?? []).filter(isUuid);
  const rows = await tx.execute<{
    id: string;
    title: string;
    purpose: string | null;
    owner_id: string;
    visibility: DashboardView["visibility"];
    project_id: string | null;
    current_version: number;
    draft: boolean;
    building: boolean;
    updated_at: string;
    can_edit: boolean;
    shared_role: ShareRole | null;
  }>(sql`
    select d.id, d.title, d.purpose, d.owner_id, d.visibility, d.project_id, d.current_version, d.updated_at,
      ${dashboardEditableBy(viewer.userId)} as can_edit, ${dashboardShareOf(viewer.userId)} as shared_role,
      ${dashboardEditableBy(viewer.userId)} and exists (
        select 1 from app.dashboard_draft r where r.org_id = d.org_id and r.dashboard_id = d.id) as draft,
      -- Being built: a run working now that has called a dashboard tool on this one (not any question asked in its
      -- conversation meanwhile), in its conversation or another it's attached to.
      -- Worked out once for the list (not a lookup a dashboard). A call's result names the dashboard only when it was
      -- the owner's to work on (a refused call's names none), in its canonical form.
      ${dashboardEditableBy(viewer.userId)} and d.id::text in (
        select t.result->>'dashboard_id'
        from app.run x join app.tool_call t on t.org_id = x.org_id and t.run_id = x.id
        where x.org_id = ${viewer.orgId} and x.parent_run_id is null
          and x.status in ('queued', 'running', 'cancelling') and t.result->>'dashboard_id' is not null
          and exists (
            select 1 from app.thread t where t.org_id = x.org_id and t.id = x.thread_id
              and ${threadReadableBy(viewer.userId)})) as building
    from app.dashboard d
    where d.org_id = ${viewer.orgId} and d.deleted_at is null and ${dashboardReadableBy(viewer.userId)}
      and (d.current_version > 0 or ${dashboardEditableBy(viewer.userId)})
      ${
        filter.threadId
          ? also.length
            ? sql`and (d.thread_id = ${filter.threadId} or d.id in (${sql.join(
                also.map((id) => sql`${id}`),
                sql`, `,
              )}))`
            : sql`and d.thread_id = ${filter.threadId}`
          : sql``
      }
    order by d.updated_at desc
    limit 200`);
  return rows.map((d) => ({
    id: d.id,
    title: d.title,
    purpose: d.purpose,
    ownerId: d.owner_id,
    mine: d.owner_id === viewer.userId,
    canEdit: Boolean(d.can_edit),
    sharedRole: d.shared_role ?? null,
    visibility: d.visibility,
    projectId: d.project_id,
    currentVersion: d.current_version,
    draft: Boolean(d.draft),
    building: Boolean(d.building),
    updatedAt: new Date(d.updated_at).toISOString(),
  }));
}

/** What a change to a dashboard begins from: its draft when there is one, else its current version. */
export interface WorkingCopy {
  id: string;
  title: string;
  threadId: string | null;
  /** The version the change is based on (the draft's base, or the current one). */
  baseVersion: number;
  /** When the draft was last saved (Postgres's text of it), or null when there's none: a change names it. */
  draftAt: string | null;
  /** Null for a dashboard with neither yet (just made). */
  definition: Definition | null;
  files: Record<string, string>;
  /**
   * The owner's work that didn't build yet, when it started from this same base: the next save goes on from it.
   * Unchecked: its definition is the model's as written.
   */
  work: AppWork | null;
}

/** A save that failed its check, kept so the next save fixes it rather than writes it all again. */
export interface AppWork {
  base: string;
  definition: unknown;
  files: Record<string, string>;
}

/**
 * What a change begins from, as a change passes it back: the version it's based on and when its draft was saved (none:
 * no draft). Given by opening a working copy and by each save; a save on anything else (another save since, a Restore,
 * a Publish) is refused, so a change made on what was seen never writes over what's there now.
 */
export const baseOf = (c: Pick<WorkingCopy, "baseVersion" | "draftAt">): string =>
  `${c.baseVersion}@${c.draftAt ?? "none"}`;
export const parseBase = (base: string): { baseVersion: number; baseDraftAt: string | null } | null => {
  const m = /^(\d+)@(.+)$/.exec(base.trim());
  return m?.[1] && m[2] ? { baseVersion: Number(m[1]), baseDraftAt: m[2] === "none" ? null : m[2] } : null;
};

/**
 * Keep work that doesn't build yet (apps as code): on an App the person changes (theirs, or shared to edit), and only while the App is still
 * on the base the work was made from (its row locked, as a save locks it). A save, Restore or Publish since means the
 * work began from something older: it's dropped, never kept over what's there now. False when it wasn't kept.
 */
export async function keepWork(tx: TenantTx, actor: Actor, dashboardId: string, work: AppWork): Promise<boolean> {
  if (!isUuid(dashboardId)) return false;
  // Held to an App's own sizes, as a build is: each failed save merges into what's kept, and work past them would
  // grow on every save and be read back by every open.
  if (oversize(work.files)) return false;
  const [d] = await tx.execute<{ current_version: number; draft_base: number | null; draft_at: string | null }>(sql`
    select d.current_version, r.base_version as draft_base, r.updated_at::text as draft_at
    from app.dashboard d
    left join app.dashboard_draft r on r.org_id = d.org_id and r.dashboard_id = d.id
    where d.org_id = ${actor.orgId} and d.id = ${dashboardId} and d.deleted_at is null
      and ${dashboardEditableBy(actor.userId)}
    for update of d`);
  if (!d) return false;
  const draft = d.draft_at !== null;
  const now = baseOf({
    baseVersion: draft ? (d.draft_base ?? d.current_version) : d.current_version,
    draftAt: draft ? d.draft_at : null,
  });
  if (now !== work.base) return false;
  await tx.execute(sql`
    update app.dashboard set work = ${JSON.stringify(work)}::jsonb
    where org_id = ${actor.orgId} and id = ${dashboardId}`);
  return true;
}

/** The working copy of a dashboard the person changes (theirs, or shared to edit); null for any other. */
export async function workingCopy(tx: TenantTx, actor: Actor, dashboardId: string): Promise<WorkingCopy | null> {
  if (!isUuid(dashboardId)) return null;
  const [d] = await tx.execute<{
    id: string;
    title: string;
    thread_id: string | null;
    current_version: number;
    draft_base: number | null;
    draft_at: string | null;
    draft_definition: Definition | null;
    draft_parts: Record<string, string> | null;
    version_definition: Definition | null;
    version_parts: Record<string, string> | null;
    work: AppWork | null;
  }>(sql`
    select d.id, d.title, d.thread_id, d.current_version, r.base_version as draft_base, r.updated_at::text as draft_at,
      r.definition as draft_definition, r.parts as draft_parts, v.definition as version_definition,
      v.parts as version_parts, d.work
    from app.dashboard d
    left join app.dashboard_draft r on r.org_id = d.org_id and r.dashboard_id = d.id
    left join app.dashboard_version v on v.org_id = d.org_id and v.dashboard_id = d.id and v.version = d.current_version
    where d.org_id = ${actor.orgId} and d.id = ${dashboardId} and d.deleted_at is null
      and ${dashboardEditableBy(actor.userId)}`);
  if (!d) return null;
  const draft = d.draft_definition !== null;

  return {
    id: d.id,
    title: d.title,
    threadId: d.thread_id,
    baseVersion: draft ? (d.draft_base ?? d.current_version) : d.current_version,
    draftAt: draft ? d.draft_at : null,
    definition: draft ? d.draft_definition : d.version_definition,
    files: (draft ? d.draft_parts : d.version_parts) ?? {},
    work: d.work ? { ...d.work, definition: withoutRetiredKeys(d.work.definition) } : null,
  };
}

/** A dashboard's versions, newest first, for whoever reads it. */
export async function listVersions(
  tx: TenantTx,
  viewer: { orgId: string; userId: string | null },
  dashboardId: string,
): Promise<{ version: number; authorId: string | null; changeNote: string | null; createdAt: string }[] | null> {
  if (!(await getDashboard(tx, viewer, dashboardId))) return null;
  const rows = await tx.execute<{
    version: number;
    author_id: string | null;
    change_note: string | null;
    created_at: string;
  }>(
    sql`
      select version, author_id, change_note, created_at from app.dashboard_version
      where org_id = ${viewer.orgId} and dashboard_id = ${dashboardId}
      order by version desc`,
  );
  return rows.map((v) => ({
    version: v.version,
    authorId: v.author_id,
    changeNote: v.change_note,
    createdAt: new Date(v.created_at).toISOString(),
  }));
}

/**
 * Restores a version: its definition and parts become the next version, the definition checked again as it'd be saved
 * today (the datasets as released now). Its parts' bundle is kept as it was checked against that same definition: a
 * bundle takes the runtime from the frame, under the contract the revision names, so it runs on today's runtime as the
 * old version itself does. `expectedVersion` is the version the person saw.
 */
export async function restoreVersion(
  tx: TenantTx,
  actor: Actor,
  dashboardId: string,
  input: { version: number; expectedVersion: number },
): Promise<{ ok: true; version: number } | { ok: false; problems: Problem[] }> {
  const d = await owned(tx, actor, dashboardId);
  if (d.current_version !== input.expectedVersion) {
    throw new DashboardProblem("conflict", "It changed since you looked at it. Open its versions again.");
  }
  const [old] = await tx.execute<{
    definition: Definition;
    parts: Record<string, string>;
    bundle: string | null;
    bundle_hash: string | null;
  }>(sql`
    select definition, parts, bundle, bundle_hash from app.dashboard_version
    where org_id = ${actor.orgId} and dashboard_id = ${dashboardId} and version = ${input.version}`);
  if (!old) throw new DashboardProblem("not_found", "That version isn't here.");
  const saved = await saveDraft(tx, actor, dashboardId, {
    definition: old.definition,
    parts: old.bundle && old.bundle_hash ? { files: old.parts, bundle: old.bundle, bundleHash: old.bundle_hash } : null,
    baseVersion: d.current_version,
  });
  if (!saved.ok) return saved;
  // Publishing refuses a version with no page; said here as what it is (rolled back with the rest).
  if (!old.bundle || !old.bundle_hash || !Object.hasOwn(old.parts ?? {}, "/App.tsx")) {
    throw new DashboardProblem(
      "invalid",
      `Version ${input.version} has no page to restore: it was saved before its code.`,
    );
  }
  const published = await publishDraft(tx, actor, dashboardId, {
    revision: saved.revision,
    note: `Restored version ${input.version}`,
  });
  return { ok: true, version: published.version };
}

/** Shares a dashboard with its project's people or the organization, or keeps it private: its owner's call. */
export async function setDashboardVisibility(
  tx: TenantTx,
  actor: Actor,
  dashboardId: string,
  visibility: DashboardView["visibility"],
): Promise<void> {
  await owned(tx, actor, dashboardId);
  const [d] = await tx.execute<{ project_id: string | null }>(sql`
    select project_id from app.dashboard where org_id = ${actor.orgId} and id = ${dashboardId}`);
  if (visibility === "project" && !d?.project_id) {
    throw new DashboardProblem("invalid", "It isn't in a project: share it with the organization, or keep it private.");
  }
  await tx.execute(sql`
    update app.dashboard set visibility = ${visibility}, updated_at = now()
    where org_id = ${actor.orgId} and id = ${dashboardId}`);
}

/** A person a dashboard is shared with by name, as its owner sees them. */
export interface DashboardShare {
  userId: string;
  role: ShareRole;
  addedAt: string;
}

/** At most this many people a dashboard: past it, share it with its project or the organization. */
const MAX_SHARES = 200;

/** The people a dashboard is shared with by name, first added first: its owner's to see. */
export async function listShares(tx: TenantTx, actor: Actor, dashboardId: string): Promise<DashboardShare[]> {
  const [d] = isUuid(dashboardId)
    ? await tx.execute<{ owner_id: string }>(sql`
        select d.owner_id from app.dashboard d
        where d.org_id = ${actor.orgId} and d.id = ${dashboardId} and d.deleted_at is null
          and ${dashboardReadableBy(actor.userId)}`)
    : [];
  if (!d) throw new DashboardProblem("not_found", "That dashboard isn't here.");
  if (d.owner_id !== actor.userId) {
    throw new DashboardProblem("not_yours", "Only its owner sees who it's shared with.");
  }
  const rows = await tx.execute<{ user_id: string; role: ShareRole; added_at: string }>(sql`
    select user_id, role, added_at from app.dashboard_share
    where org_id = ${actor.orgId} and dashboard_id = ${dashboardId}
    order by added_at, id`);
  return rows.map((r) => ({ userId: r.user_id, role: r.role, addedAt: new Date(r.added_at).toISOString() }));
}

/**
 * Shares a dashboard with one person, changes what they may do, or (role null) stops sharing it with them: its
 * owner's call. Whoever is added is a member of the organization now, and a viewer of the organization is only ever
 * added to view (viewers don't build). Removing someone works whether or not they're still a member, so a share left
 * by someone who left can always be cleared.
 */
export async function shareDashboard(
  tx: TenantTx,
  actor: Actor,
  dashboardId: string,
  input: { userId: string; role: ShareRole | null },
): Promise<void> {
  await owned(tx, actor, dashboardId);
  if (!isUuid(input.userId)) throw new DashboardProblem("invalid", "That isn't someone in this workspace.");
  if (input.userId === actor.userId) {
    throw new DashboardProblem("invalid", "It's yours: you read it and change it already.");
  }
  if (input.role === null) {
    await tx.execute(sql`
      delete from app.dashboard_share
      where org_id = ${actor.orgId} and dashboard_id = ${dashboardId} and user_id = ${input.userId}::uuid`);
    return;
  }
  const [m] = await tx.execute<{ role: string | null }>(sql`select app.member_role(${input.userId}::uuid) as role`);
  if (!m?.role) throw new DashboardProblem("invalid", "They aren't in this workspace.");
  if (input.role === "edit" && m.role === "viewer") {
    throw new DashboardProblem("invalid", "They're a viewer in this workspace: share it with them to view.");
  }
  const [count] = await tx.execute<{ n: number; had: boolean }>(sql`
    select count(*)::int as n, bool_or(user_id = ${input.userId}::uuid) as had from app.dashboard_share
    where org_id = ${actor.orgId} and dashboard_id = ${dashboardId}`);
  if (!count?.had && (count?.n ?? 0) >= MAX_SHARES) {
    throw new DashboardProblem(
      "invalid",
      `It's shared with ${MAX_SHARES} people: share it with its project or everyone instead.`,
    );
  }
  await tx.execute(sql`
    insert into app.dashboard_share (org_id, id, dashboard_id, user_id, role, added_by)
    values (${actor.orgId}, ${uuidv7()}, ${dashboardId}, ${input.userId}::uuid, ${input.role}, ${actor.userId})
    on conflict (org_id, dashboard_id, user_id) do update set role = excluded.role`);
}

/** Deletes a dashboard (its owner, or an owner or admin of the organization who reads it): gone for everyone. */
export async function deleteDashboard(
  tx: TenantTx,
  actor: Actor & { canManage: boolean },
  dashboardId: string,
): Promise<void> {
  const [d] = isUuid(dashboardId)
    ? await tx.execute<{ owner_id: string; readable: boolean }>(sql`
        select d.owner_id, ${dashboardReadableBy(actor.userId)} as readable from app.dashboard d
        where d.org_id = ${actor.orgId} and d.id = ${dashboardId} and d.deleted_at is null`)
    : [];
  // One they can't read isn't there for them, an owner or admin of the organization included.
  if (!d?.readable) throw new DashboardProblem("not_found", "That dashboard isn't here.");
  if (d.owner_id !== actor.userId && !actor.canManage) {
    throw new DashboardProblem("not_yours", "Only its owner, or an owner or admin, deletes a dashboard.");
  }
  await tx.execute(sql`
    update app.dashboard set deleted_at = now(), updated_at = now()
    where org_id = ${actor.orgId} and id = ${dashboardId}`);
}

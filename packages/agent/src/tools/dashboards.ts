/**
 * The analyst's dashboard tools: it plans an App, saves its draft (the definition and the App's
 * code, checked together), and opens what it saved. The person publishes, never the analyst: a draft
 * is seen only by its owner and its editors until its owner presses Publish on its page, so a note in fetched content
 * that tells the analyst to change a dashboard can at most change a draft, which they look at first.
 *
 * Which dashboard a call works on is the conversation's to say, never the model's: one made in this conversation by
 * the person asking, or one they change (theirs, or shared with them to edit) that they attached to it. A dashboard
 * reads the run's source. Its code is bundled and type-checked here, in the worker
 * (esbuild and TypeScript never run in the web server).
 */
import { checkParts, describeProblems, lookFindings, oversize, LIMITS as PART_LIMITS } from "@opendash/apps/build";
import { AppPlan, checkDefinition, OwnDataset, Plan, type Problem } from "@opendash/apps/dashboard";
import { dashboardEditableBy, dashboards, fenced } from "@opendash/core";
import { sql } from "@opendash/db";
import { z } from "zod";
import { defineTool, type ToolContext } from "./types";

/** At most this many dashboards made in one conversation: a loop that makes one per step stops here. */
const DASHBOARDS_PER_CONVERSATION = 3;
/** Files a save may write at once: a component, and the files it shares. */
// Enough for a whole first build in one save; each save is checked as a whole anyway.
const FILES_PER_SAVE = 16;

const DashboardId = z.string().max(40).optional().describe("The dashboard's dashboard_id; leave out to make a new one");
const Base = z
  .string()
  .max(80)
  .optional()
  .describe("For a change to a dashboard: the base your last dashboard_open or dashboard_save of it gave");

/** What a failed save says about the work it kept. */
const KEPT =
  "Your manifest and files are kept as you wrote them: fix only what's listed, with edits or set (same dashboard_id and base), never by writing the files again.";

const failed = (message: string, extra: Record<string, unknown> = {}) => ({
  value: { error: message, ...extra },
  summary: { failed: true, message },
});

const problemLines = (problems: Problem[]) => problems.slice(0, 30).map((p) => `${p.path}: ${p.message}`);

/**
 * A refusal in words for the person watching (the model gets the paths): `filters.f_plan.default` becomes the Plan
 * filter, a query or dataset its own name.
 */
export function problemsInWords(definition: unknown, problems: Problem[]): string[] {
  const d = (definition ?? {}) as { filters?: Record<string, { label?: string }> };
  return problems.slice(0, 4).map((p) => {
    const filter = /^filters\.([a-z0-9_]+)/.exec(p.path);
    const named = /^(queries|datasets)\.([a-z0-9_]+)/.exec(p.path);
    let where = "";
    if (filter) where = `The ${d.filters?.[filter[1] as string]?.label ?? filter[1]} filter`;
    else if (named) {
      // Which part of it, when the path says (a dataset's third column): the same message for four columns reads as four.
      const part = p.path
        .slice(named[0].length)
        .replace(/^\./, "")
        .replace(/\[(\d+)\]/g, (_, n) => ` ${Number(n) + 1}`);
      where = `${named[1] === "datasets" ? `Its own dataset ${named[2]}` : `Its query ${named[2]}`}${part ? `, ${part.replace(/\./g, " ")}` : ""}`;
    }
    return where ? `${where}: ${p.message}` : p.message;
  });
}

/** A refused definition: the paths for the model, the words for the person. */
const refused = (definition: unknown, problems: Problem[]) => ({
  value: {
    error: `The definition doesn't pass its check: nothing was published to the page. ${KEPT}`,
    problems: problemLines(problems),
  },
  summary: {
    failed: true,
    message: "The definition doesn't pass its check: nothing was saved.",
    problems: problemsInWords(definition, problems),
  },
});

/** The person a dashboard is built for: the one who asked. */
const actorOf = (ctx: ToolContext) => (ctx.run.askedBy ? { orgId: ctx.run.orgId, userId: ctx.run.askedBy } : null);

/**
 * The dashboards the asker attached to this conversation (@, or the panel beside one), or a piece of which they
 * selected to change (select to edit): those they change (theirs, or shared with them to edit) are changed from here
 * too, not only from the conversation each was built in.

 */
async function attachedHere(ctx: ToolContext, actor: { orgId: string; userId: string }): Promise<Set<string>> {
  const rows = await ctx.deps.withTenant(ctx.run.orgId, (tx) =>
    tx.execute<{ id: string }>(sql`
      select distinct case when a.value->>'kind' = 'app_element' then a.value->>'dashboardId' else a.value->>'id' end
        as id
      from app.message m, jsonb_array_elements(m.attachments) a
      where m.org_id = ${ctx.run.orgId} and m.thread_id = ${ctx.run.threadId} and m.role = 'user'
        and m.status = 'complete' and m.author_id = ${actor.userId}
        and a.value->>'kind' in ('dashboard', 'app_element')`),
  );
  return new Set(rows.map((r) => r.id));
}

/**
 * Whether a dashboard the asker changes (its working copy is theirs to read) can be changed here: built in this
 * conversation, or attached to it by them and reading only sources and services this conversation can read (so an App
 * on a connected service, attached, isn't refused as "not changeable here" and built again beside it). The save
 * checks each query's source again.
 */
const changeableHere = async (
  ctx: ToolContext,
  actor: { orgId: string; userId: string },
  copy: Pick<dashboards.WorkingCopy, "id" | "threadId" | "definition">,
  attached?: Set<string>,
) =>
  copy.threadId === ctx.run.threadId ||
  ((attached ?? (await attachedHere(ctx, actor))).has(copy.id) && readsWhatThisCan(ctx, copy.definition));

/** Every query of a definition reads a source this run can read, or a service dataset of its own. */
function readsWhatThisCan(ctx: ToolContext, definition: unknown): boolean {
  const d = (definition ?? {}) as {
    queries?: Record<string, { source?: { connection?: string } }>;
    datasets?: Record<string, { connection?: string; service?: unknown }>;
  };
  const readable = new Set([ctx.source.connectionId, ...ctx.sources.others.map((o) => o.id)]);
  const services = new Set(
    Object.values(d.datasets ?? {}).flatMap((ds) => (ds?.service && ds.connection ? [ds.connection] : [])),
  );
  return Object.values(d.queries ?? {}).every((q) => {
    const c = q?.source?.connection ?? "";
    return readable.has(c) || services.has(c);
  });
}

/**
 * The conversation's dashboards this person changes (built here, or attached by them: theirs, or shared with them to
 * edit), newest first.
 */
async function ofConversation(ctx: ToolContext, actor: { orgId: string; userId: string }) {
  const attached = [...(await attachedHere(ctx, actor))];
  const list = await ctx.deps.withTenant(ctx.run.orgId, (tx) =>
    dashboards.listDashboards(tx, actor, { threadId: ctx.run.threadId, alsoIds: attached }),
  );
  return list.filter((d) => d.canEdit);
}

/**
 * What a change begins from, as the model passes it back (dashboard_open and dashboard_save give it): the store's, so
 * its check of kept work reads it the same way.
 */
const { baseOf, parseBase } = dashboards;

/** The conversation's dashboards with their working titles (a draft's, before it's published). */
async function workingTitles(ctx: ToolContext, actor: { orgId: string; userId: string }) {
  const mine = await ofConversation(ctx, actor);
  return ctx.deps.withTenant(ctx.run.orgId, async (tx) =>
    Promise.all(
      mine.map(async (d) => ({
        id: d.id,
        title: (await dashboards.workingCopy(tx, actor, d.id))?.definition?.title ?? d.title,
      })),
    ),
  );
}

/** Thrown inside the save's transaction to roll it back (a dashboard made in it included). */
class Refused extends Error {
  constructor(readonly problems: Problem[]) {
    super("refused");
  }
}

/** A dashboard of this conversation, as its working copy; an error for any other. */
async function conversationCopy(ctx: ToolContext, actor: { orgId: string; userId: string }, id: string) {
  const copy = await ctx.deps.withTenant(ctx.run.orgId, (tx) => dashboards.workingCopy(tx, actor, id.trim()));
  if (!copy || !(await changeableHere(ctx, actor, copy))) {
    return {
      error: `dashboard_id ${id} isn't a dashboard you can change here: only one the asker changes (their own, or one shared with them to edit), made in this conversation or attached to it by them and reading this conversation's source. To change another, they ask in the panel beside it.`,
    };
  }
  return copy;
}

export const dashboardPlan = defineTool({
  name: "dashboard_plan",
  description:
    'Shows the person the App you mean to build: what it\'s for in a line, what it reads, and each screen (a page) with its pieces in the order the person meets them, each a "kind": "custom" with a title and a one-line detail of what it shows or lets them do. They answer with Build it, or a reply to change it. Ends your turn. For a change to this conversation\'s App (anything they ask to add or change in it), pass its dashboard_id; set separate only when they asked for another, separate App.',
  effect: "internal",
  schema: z.object({
    dashboard_id: DashboardId,
    plan: AppPlan,
    separate: z
      .boolean()
      .optional()
      .describe("true only when the person asked for another, separate App beside the one this conversation has"),
  }),
  async execute(input, ctx) {
    const actor = actorOf(ctx);
    if (!actor) return failed("Dashboards are built for a person, and no one asked here.");
    // A conversation's App grows by changes to it: a plan for a second App needs the person to have asked for one
    // (so "build that into the dashboard" changes the one there, never makes a new App beside it).
    if (!input.dashboard_id && !input.separate) {
      const here = await workingTitles(ctx, actor);
      if (here.length) {
        const list = here.map((d) => `"${d.title}" (dashboard_id ${d.id})`).join(", ");
        return failed(
          `This conversation already has ${list}. To add to it or change it, plan with its dashboard_id. Only if they asked for another, separate App, plan again with separate: true.`,
        );
      }
    }
    if (input.dashboard_id) {
      const copy = await conversationCopy(ctx, actor, input.dashboard_id);
      if ("error" in copy) return failed(copy.error);
    }
    // It reads what the source has: a dataset (released, or checked), or a table its own SQL reads. A name that's
    // neither can't be built.
    const { datasets, tables, services } = await ctx.deps.withTenant(ctx.run.orgId, async (tx) => ({
      datasets: Object.keys(
        (await dashboards.dashboardCatalog(tx, ctx.run.orgId, ctx.source.connectionId))?.catalog ?? {},
      ),
      tables: (
        await tx.execute<{ fq_name: string; name: string }>(sql`
          select fq_name, name from app.catalog_object
          where org_id = ${ctx.run.orgId} and connection_id = ${ctx.source.connectionId}
            and kind in ('table', 'view') and removed_at is null`)
      ).flatMap((t) => [t.fq_name.toLowerCase(), t.name.toLowerCase()]),
      // A connected service a dashboard may read (its server's name: "Jira").
      services: (
        await tx.execute<{ name: string }>(sql`
          select name from app.mcp_server
          where org_id = ${ctx.run.orgId} and status = 'active' and dashboards_allowed`)
      ).map((r) => r.name.toLowerCase()),
    }));
    const known = new Set([...datasets, ...tables, ...services]);
    // A connected service or another source this conversation reads, named as itself or "Name: what it holds"
    // ("Fullstory: checkout funnel events" must be accepted while Fullstory is connected).
    const elsewhere = [...services, ...ctx.sources.others.map((o) => o.name.toLowerCase())];
    const named = (d: string) => {
      const lower = d.trim().toLowerCase();
      return known.has(lower) || elsewhere.some((n) => lower === n || lower.startsWith(`${n}:`));
    };
    const unknown = input.plan.datasets.filter((d) => !named(d));
    if (unknown.length) {
      return {
        value: {
          accepted: false,
          error: `${ctx.source.name} has no dataset or table ${unknown.join(", ")}. Its datasets: ${datasets.join(", ") || "none yet"}; any table it has learned can be read by the dashboard's own SQL (name it schema.table)${services.length ? `; services: ${services.join(", ")}` : ""}.`,
        },
        summary: { failed: true, message: `No ${unknown.join(", ")}` },
      };
    }
    return {
      value: { accepted: true, next: "The person sees your plan as a card. Your turn ends here." },
      summary: { title: input.plan.title, pages: input.plan.pages.length },
    };
  },
});

/** Keys a path may never name: a change reaches the definition's own data, never an object's prototype. */
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/**
 * The definition with each change made at its path (keys and list positions joined by dots; null removes), on a copy;
 * or why one can't be made. The save then checks the whole as it would a definition passed whole.
 */
export function setPaths(
  definition: Record<string, unknown>,
  changes: { path: string; value: unknown }[],
): { value: Record<string, unknown> } | { error: string } {
  const out = structuredClone(definition);
  for (const { path, value } of changes) {
    const keys = path.split(".").filter(Boolean);
    if (!keys.length || keys.some((k) => UNSAFE_KEYS.has(k))) return { error: `"${path}" isn't a path in it.` };
    let here: unknown = out;
    for (const k of keys.slice(0, -1)) {
      const next = Array.isArray(here) ? here[Number(k)] : (here as Record<string, unknown> | null)?.[k];
      if (next === null || typeof next !== "object") {
        return { error: `"${path}": there's nothing at ${k}. Open it with dashboard_open to see its paths.` };
      }
      here = next;
    }
    const last = keys.at(-1) as string;
    if (Array.isArray(here)) {
      const at = Number(last);
      if (!Number.isInteger(at) || at < 0 || at > here.length)
        return { error: `"${path}": no item ${last} in that list.` };
      if (value === null) here.splice(at, 1);
      else here[at] = value;
    } else {
      const o = here as Record<string, unknown>;
      if (value === null) delete o[last];
      else o[last] = value;
    }
  }
  return { value: out };
}

export const dashboardSave = defineTool({
  name: "dashboard_save",
  description:
    "Saves the draft of a dashboard: makes it on the first call (leave out dashboard_id; its title from the definition), then changes this conversation's dashboard (its dashboard_id, and the base your last dashboard_open or dashboard_save of it gave). Pass the whole definition when it changes (or leave it out to keep the draft's), and the App's files to write or remove (null): /App.tsx, its components and helpers. The definition and the code are checked together; nothing is saved until both pass, and what failed comes back by path, or file and line, to fix in the next call. The person watches the draft beside the conversation; only they see it, until they publish it from its page.",
  effect: "internal",
  time: "slow",
  schema: z.object({
    dashboard_id: DashboardId,
    base: Base,
    definition: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("The whole manifest as it should be (build-an-app's format: version 2, its queries and filters)"),
    files: z
      .record(z.string().max(80), z.string().max(PART_LIMITS.fileChars).nullable())
      .optional()
      .describe('Files to write, or null to remove: {"/components/Queue.tsx": "…"}'),
    set: z
      .array(z.object({ path: z.string().max(200), value: z.unknown() }))
      .max(30)
      .optional()
      .describe(
        'A small change to the saved definition instead of it whole: [{"path": "queries.q_open.sort", "value": ["-age"]}]; null removes',
      ),
    edits: z
      .array(z.object({ file: z.string().max(80), old: z.string().min(1).max(4_000), new: z.string().max(8_000) }))
      .max(20)
      .optional()
      .describe("A small change to a saved file instead of it whole: its exact old text (once in it) and the new"),
  }),
  async execute(input, ctx, call) {
    const actor = actorOf(ctx);
    if (!actor) return failed("Dashboards are built for a person, and no one asked here.");
    if ((input.set?.length || input.edits?.length) && !input.dashboard_id) {
      return failed("set and edits change a saved dashboard: pass its dashboard_id and base.");
    }
    const writes = Object.entries(input.files ?? {});
    if (writes.length > FILES_PER_SAVE) return failed(`Write at most ${FILES_PER_SAVE} files a save.`);

    // What the change begins from: this conversation's dashboard (its draft, or its current version) as the model saw
    // it (its base), or nothing.
    const copy = input.dashboard_id ? await conversationCopy(ctx, actor, input.dashboard_id) : null;
    if (copy && "error" in copy) return failed(copy.error);
    const base = copy ? parseBase(input.base ?? "") : null;
    if (copy && !base) {
      return failed(
        `Pass its base: open it with dashboard_open (dashboard_id ${copy.id}), then save your change on it.`,
      );
    }
    // A change made on what's no longer there (a save, Restore or Publish since) is refused before anything is built,
    // as the store would refuse it: its work, kept under today's base, would open next as if it were made on it.
    if (copy && base && (base.baseVersion !== copy.baseVersion || base.baseDraftAt !== copy.draftAt)) {
      return failed(
        "It changed since this change began. Call dashboard_open for it as it is now, then save your change on that.",
      );
    }
    if (!copy) {
      // A new one: never a second of a title this conversation has (a retry after a crash, a call without its id).
      const title = (input.definition as { title?: unknown } | undefined)?.title;
      const same = (await workingTitles(ctx, actor)).find((d) => typeof title === "string" && d.title === title.trim());
      if (same) {
        return failed(
          `This conversation already has "${same.title}" (dashboard_id ${same.id}): open it with dashboard_open and save your change on it with its base.`,
        );
      }
    }
    // What didn't build last time, when nothing was saved over it since: this save goes on from it, so a failed save
    // never means writing every file again, a minute each.
    const work = copy?.work && copy.work.base === baseOf(copy) ? copy.work : null;
    let definition = input.definition ?? (work?.definition as typeof input.definition) ?? copy?.definition;
    if (!definition) return failed("Give its definition: there's none saved yet.");
    if (input.set?.length) {
      const changed = setPaths(definition, input.set);
      if ("error" in changed) return failed(changed.error);
      definition = changed.value;
    }
    const files: Record<string, string> = { ...(work?.files ?? copy?.files ?? {}) };
    for (const [path, source] of writes) {
      if (source === null) delete files[path];
      else files[path] = source;
    }
    for (const e of input.edits ?? []) {
      const text = files[e.file];
      if (text === undefined) return failed(`There's no file ${e.file} saved: write it whole with files.`);
      const times = text.split(e.old).length - 1;
      if (times !== 1) {
        return failed(
          times === 0
            ? `${e.file} doesn't contain that old text exactly: open it with dashboard_open and copy the lines as they are.`
            : `That old text is in ${e.file} ${times} times: give more of the lines around it so it's once.`,
        );
      }
      files[e.file] = text.replace(e.old, () => e.new);
    }
    // Past an App's size the build refuses it anyway, and its work isn't kept either: kept, each failed save would add
    // to it, and every later open and save would read it all.
    const tooBig = oversize(files);
    if (tooBig) {
      return failed(
        `${tooBig} Nothing was saved or kept: make it smaller (fewer files, or shorter ones), then save again on the same base.`,
      );
    }

    // Every query, and every dataset of its own, reads a source this run can read (an App reads
    // any of the person's sources, not only the one the question started on; sample data stays apart, as the run's
    // sources keep it), or a service dataset of its own (an MCP server's id is its connection), read as the person.
    const readable = new Set([ctx.source.connectionId, ...ctx.sources.others.map((o) => o.id)]);
    const ownSets = (definition as { datasets?: Record<string, { connection?: string; service?: unknown }> }).datasets;
    const services = new Set(
      Object.values(ownSets ?? {}).flatMap((ds) => (ds?.service && ds.connection ? [ds.connection] : [])),
    );
    const others = [
      ...Object.entries(
        (definition as { queries?: Record<string, { source?: { connection?: string } }> }).queries ?? {},
      ).filter(([, q]) => !readable.has(q?.source?.connection ?? "") && !services.has(q?.source?.connection ?? "")),
      ...Object.entries(ownSets ?? {}).filter(([, ds]) => !readable.has(ds?.connection ?? "") && !ds?.service),
    ];
    if (others.length) {
      const names = [ctx.source, ...ctx.sources.others].map(
        (x) => `${x.name} ("${"connectionId" in x ? x.connectionId : x.id}")`,
      );
      return failed(
        `${others.map(([id]) => id).join(", ")} ${others.length === 1 ? "reads" : "read"} a source this conversation can't: its queries and datasets read ${names.join(", ")}.`,
      );
    }

    // Its own datasets (SQL over the source's tables), new or changed: each run once through the gateway, as Ask's SQL
    // is, which types its columns. Outside any transaction: the warehouse is slow next to a lock.
    // A check that fails keeps the work as written, so the fix is an edit, not every file again.
    const keep = async <T>(result: T): Promise<T> => {
      if (!copy) return result;
      // On the base it began from, and only while the App is still on it: a save landing meanwhile wins.
      const kept = { base: baseOf(copy), definition, files };
      await ctx.deps.withTenant(ctx.run.orgId, (tx) => dashboards.keepWork(tx, actor, copy.id, kept));
      return result;
    };
    const ownProblems = await probeOwn(definition, copy?.definition, ctx, call);
    if (ownProblems.length) return keep(refused(definition, ownProblems));

    // The definition first (the datasets as released now), then the code against its ids. Both outside a transaction.
    const checked = await ctx.deps.withTenant(ctx.run.orgId, async (tx) =>
      checkDefinition(definition, { catalogs: await dashboards.catalogsFor(tx, ctx.run.orgId, definition) }),
    );
    if (!checked.ok) return keep(refused(definition, checked.problems));
    let parts: dashboards.PartsBuild | null = null;
    if (Object.keys(files).length) {
      const built = await checkParts({ files, definition: checked.definition });
      if (!built.ok || !built.bundle || !built.bundleHash) {
        const problems = describeProblems(built);
        return keep({
          value: { error: `The App doesn't build yet: nothing was published to the page. ${KEPT}`, problems },
          summary: { failed: true, message: "The App doesn't build yet.", count: problems.split("\n").length },
        });
      }
      parts = { files, bundle: built.bundle, bundleHash: built.bundleHash };
    }

    // Saved under the dashboard's lock, only on what this change began from; a new one made in the same write, and
    // rolled back with it when the save is refused.
    const title = checked.definition.title;
    try {
      const saved = await fenced(ctx.deps, ctx.run, async (tx) => {
        let id = copy?.id;
        let made = false;
        if (!id) {
          const mine = (await dashboards.listDashboards(tx, actor, { threadId: ctx.run.threadId })).filter(
            (d) => d.mine,
          );
          // Again here, under the run's lock: a save running beside this one may have made it since the check above.
          for (const d of mine) {
            const working = (await dashboards.workingCopy(tx, actor, d.id))?.definition?.title ?? d.title;
            if (working === title) {
              throw new dashboards.DashboardProblem(
                "invalid",
                `This conversation already has "${working}" (dashboard_id ${d.id}): open it with dashboard_open and save your change on it with its base.`,
              );
            }
          }
          if (mine.length >= DASHBOARDS_PER_CONVERSATION) {
            throw new dashboards.DashboardProblem(
              "invalid",
              `This conversation has made ${DASHBOARDS_PER_CONVERSATION} dashboards: change one of them (dashboard_id).`,
            );
          }
          id = await dashboards.createDashboard(tx, actor, {
            title,
            purpose: checked.definition.description ?? null,
            threadId: ctx.run.threadId,
          });
          made = true;
        }
        const result = await dashboards.saveDraft(tx, actor, id, {
          definition: checked.definition,
          parts,
          baseVersion: base?.baseVersion ?? 0,
          baseDraftAt: base?.baseDraftAt ?? null,
          // Its saves can be undone together from the conversation.
          runId: ctx.run.id,
        });
        if (!result.ok) throw new Refused(result.problems);
        const after = await dashboards.workingCopy(tx, actor, id);
        return { id, made, revision: result.revision, base: after ? baseOf(after) : null };
      });
      // What in its code looks generated: findings to fix with the rest, never a refusal.
      const looks = lookFindings(files).map((f) => `${f.file}: ${f.message}`);
      return {
        value: {
          dashboard_id: saved.id,
          base: saved.base,
          saved: "draft",
          ...(looks.length
            ? {
                looks_generated: looks,
                looks_note: "Saved. These look generated (app-design's anti-slop.md): fix them with your next edits.",
              }
            : {}),
          next: "The person sees the draft beside the conversation. Go on with what's left (a component, a fix); before you answer, call app_check and fix what it finds, and read each file once against react-app-craft and app-design's review. When it's what was asked for, answer in two or three lines: what's there and what it's for, and that it's a draft they publish from its page when it looks right. No figures: the App shows them.",
        },
        summary: {
          dashboardId: saved.id,
          title,
          revision: saved.revision,
          made: saved.made,
          app: true,
        },
      };
    } catch (error) {
      if (error instanceof Refused) return refused(definition, error.problems);
      if (!(error instanceof dashboards.DashboardProblem)) throw error;
      return failed(
        error.code === "conflict"
          ? `${error.message} Call dashboard_open for it as it is now, then save your change on that.`
          : error.message,
      );
    }
  },
});

/**
 * Checks the definition's own datasets that are new or changed since the saved copy: each run through the gateway,
 * its column types written back from what it returns. A dataset whose shape is wrong is left to the definition check.
 */
async function probeOwn(
  definition: Record<string, unknown>,
  before: unknown,
  ctx: ToolContext,
  call: { rowId: string; signal: AbortSignal },
): Promise<Problem[]> {
  const datasets = (definition as { datasets?: Record<string, unknown> }).datasets;
  if (!datasets || typeof datasets !== "object") return [];
  const had = (before as { datasets?: Record<string, OwnDataset> } | undefined)?.datasets ?? {};
  // The same contract on the same source (a conversation can switch sources: a moved one is checked there).
  const contract = (d: OwnDataset) =>
    "sql" in d
      ? JSON.stringify([d.connection, d.sql, d.columns, d.key ?? null, d.links ?? []])
      : JSON.stringify([d.connection, d.service.tool, d.service.arguments, d.rows ?? null, d.columns, d.key ?? null]);
  const same = (a: OwnDataset, b: OwnDataset | undefined) => b !== undefined && contract(a) === contract(b);
  const problems: Problem[] = [];
  for (const [name, raw] of Object.entries(datasets)) {
    const parsed = OwnDataset.safeParse(raw);
    if (!parsed.success) continue;
    const kept = had[name];
    // A service dataset unchanged keeps the digest it was checked with; a new or changed one is run once now.
    if (same(parsed.data, kept)) {
      if (!("sql" in parsed.data) && kept && !("sql" in kept) && kept.service.digest) {
        datasets[name] = { ...parsed.data, service: { ...parsed.data.service, digest: kept.service.digest } };
      }
      continue;
    }
    if (!("sql" in parsed.data)) {
      if (!ctx.run.askedBy) {
        problems.push({ path: `datasets.${name}`, message: "A service is read as a person, and no one asked here." });
        continue;
      }
      const probed = await dashboards.probeServiceDataset(
        { withTenant: ctx.deps.withTenant, ...(ctx.deps.mcp ? { mcp: ctx.deps.mcp } : {}) },
        { orgId: ctx.run.orgId, owner: ctx.run.askedBy, name, ds: parsed.data, signal: call.signal },
      );
      if (!probed.ok) problems.push({ path: `datasets.${name}.service`, message: probed.message });
      else datasets[name] = { ...parsed.data, service: { ...parsed.data.service, digest: probed.digest } };
      continue;
    }
    const checked = await dashboards.probeOwnDataset(ctx.gateway, {
      orgId: ctx.run.orgId,
      name,
      dataset: parsed.data,
      requester: ctx.requester,
      toolCallId: call.rowId,
      signal: call.signal,
    });
    if (!checked.ok) problems.push({ path: `datasets.${name}.sql`, message: checked.message });
    else datasets[name] = { ...parsed.data, columns: checked.columns };
  }
  return problems;
}

/** The plan this conversation's person last approved for a new dashboard, with the run it came from. */
/**
 * The plan this conversation's person last approved (the newest plan card in it), with the run it came from: a plan
 * for a new dashboard, or a change to one it made (its dashboardId).
 */
async function latestPlan(ctx: ToolContext): Promise<{ runId: string; plan: Plan; dashboardId: string | null } | null> {
  const [row] = await ctx.deps.withTenant(ctx.run.orgId, (tx) =>
    tx.execute<{ id: string; outcome: Record<string, unknown> }>(sql`
      select r.id, r.outcome from app.run r
      where r.org_id = ${ctx.run.orgId} and r.thread_id = ${ctx.run.threadId} and r.id <> ${ctx.run.id}
        and r.outcome->>'kind' = 'dashboard_plan'
      order by r.queued_at desc limit 1`),
  );
  const parsed = Plan.safeParse(row?.outcome);
  if (!row || !parsed.success) return null;
  const id = row.outcome.dashboardId;
  return { runId: row.id, plan: parsed.data, dashboardId: typeof id === "string" ? id : null };
}

export const dashboardStart = defineTool({
  name: "dashboard_start",
  description:
    "After Build it, before anything else: makes the App from the plan the person approved, so it's listed at once, and gives its dashboard_id and base (for a plan changing one this conversation made: that one, as it is). Then write it with dashboard_save. Called again, it gives the same App.",
  effect: "internal",
  schema: z.object({}),
  async execute(_input, ctx) {
    const actor = actorOf(ctx);
    if (!actor) return failed("Dashboards are built for a person, and no one asked here.");
    const approved = await latestPlan(ctx);
    if (!approved) return failed("There's no plan here: show one with dashboard_plan first.");
    const { plan, runId } = approved;
    // A change plan may be for one of theirs they attached here; the update below is rolled back for any other.
    const attached = await attachedHere(ctx, actor);
    try {
      const started = await fenced(ctx.deps, ctx.run, async (tx) => {
        // A change plan builds into the dashboard it changes; a new one's plan, into the one made from it (made now,
        // or found again: one dashboard a plan). Only a new dashboard counts against the conversation's three.
        let id = approved.dashboardId;
        let made = false;
        if (id) {
          // A change plan becomes the dashboard's plan: its pages' order, and what's still to come, are this one's
          // (an editor's change plan too: they see the plan's outline as its owner does).
          await tx.execute(sql`
            update app.dashboard d set plan = ${JSON.stringify(plan)}::jsonb
            where d.org_id = ${ctx.run.orgId} and d.id = ${id} and d.deleted_at is null
              and ${dashboardEditableBy(actor.userId)}`);
        } else {
          const [had] = await tx.execute<{ id: string }>(sql`
            select id from app.dashboard
            where org_id = ${ctx.run.orgId} and plan_run_id = ${runId} and owner_id = ${actor.userId}
              and deleted_at is null`);
          if (had) id = had.id;
          else {
            const mine = (await dashboards.listDashboards(tx, actor, { threadId: ctx.run.threadId })).filter(
              (d) => d.mine,
            );
            if (mine.length >= DASHBOARDS_PER_CONVERSATION) {
              throw new dashboards.DashboardProblem(
                "invalid",
                `This conversation has made ${DASHBOARDS_PER_CONVERSATION} dashboards: change one of them.`,
              );
            }
            const started = await dashboards.startDashboard(tx, actor, {
              threadId: ctx.run.threadId,
              planRunId: runId,
              plan: plan as Plan & Record<string, unknown>,
            });
            id = started.id;
            made = started.made;
          }
        }
        const copy = await dashboards.workingCopy(tx, actor, id);
        if (!copy || !(await changeableHere(ctx, actor, copy, attached))) {
          throw new dashboards.DashboardProblem(
            "invalid",
            "That plan's dashboard isn't one this conversation can change.",
          );
        }
        return { id, made, base: baseOf(copy) };
      });
      return {
        value: {
          dashboard_id: started.id,
          base: started.base,
          next: "It's listed now, empty until its first save. Write it with dashboard_save on this dashboard_id and base: first the manifest (version 2: its queries and filters) with /App.tsx, then its components, a few files a save; then app_check.",
        },
        summary: { dashboardId: started.id, title: plan.title, started: started.made, pages: plan.pages.length },
      };
    } catch (error) {
      if (!(error instanceof dashboards.DashboardProblem)) throw error;
      return failed(error.message);
    }
  },
});

const numbered = (text: string) =>
  text
    .split("\n")
    .map((line, i) => `${String(i + 1).padStart(4)}  ${line}`)
    .join("\n");

export const dashboardOpen = defineTool({
  name: "dashboard_open",
  description:
    "Opens this conversation's dashboards: without dashboard_id, lists them; with one, its definition as the draft (or its version) has it and its files; with a path too, that file, line-numbered.",
  effect: "read",
  schema: z.object({
    dashboard_id: DashboardId,
    path: z.string().max(80).optional().describe("A file to read: /components/Queue.tsx"),
  }),
  async execute(input, ctx) {
    const actor = actorOf(ctx);
    if (!actor) return failed("Dashboards are built for a person, and no one asked here.");
    if (!input.dashboard_id) {
      const list = await ofConversation(ctx, actor);
      return {
        value: {
          dashboards: list.map((d) => ({
            dashboard_id: d.id,
            title: d.title,
            version: d.currentVersion,
            draft: d.draft,
          })),
        },
        summary: { listed: list.length },
      };
    }
    const found = await conversationCopy(ctx, actor, input.dashboard_id);
    if ("error" in found) return failed(found.error);
    // Work that doesn't build yet is what the next save goes on from: that's what it opens.
    const work = found.work && found.work.base === baseOf(found) ? found.work : null;
    const copy = work ? { ...found, definition: work.definition as typeof found.definition, files: work.files } : found;
    if (input.path) {
      const text = copy.files[input.path];
      if (text === undefined)
        return failed(`${input.path} isn't one of its files: ${Object.keys(copy.files).join(", ") || "it has none"}.`);
      return {
        value: { path: input.path, text: numbered(text) },
        summary: { dashboardId: copy.id, title: copy.title },
      };
    }
    return {
      value: {
        dashboard_id: copy.id,
        title: copy.definition?.title ?? copy.title,
        base: baseOf(copy),
        from: work
          ? "your work that doesn't build yet (the page shows the last build that passed)"
          : copy.draftAt
            ? "its draft"
            : `version ${copy.baseVersion}`,
        definition: copy.definition,
        files: Object.fromEntries(Object.entries(copy.files).map(([p, t]) => [p, `${t.split("\n").length} lines`])),
      },
      summary: { dashboardId: copy.id, title: copy.title },
    };
  },
});

/** How long app_check waits for the person's browser to measure the newest revision, and how often it looks. */
const CHECK_WAIT_MS = 25_000;
const CHECK_EVERY_MS = 2_500;

export const appCheck = defineTool({
  name: "app_check",
  description:
    "The render check of an App's draft as it stands: what the person's browser measured at a phone's width (390px), beside the analyst (760px) and full width (1280px): the page scrolling sideways, pieces overlapping, text cut off, queries that came back empty or failed, errors; and under `speed`, advice on what makes it slow to show its numbers (queries asked in rounds that wait for each other, a query that takes seconds in the warehouse). Call it after your last save and fix what it finds before you answer. It waits a little for the newest save to be measured; when no one has the App open, it says so.",
  effect: "read",
  time: "slow",
  schema: z.object({ dashboard_id: z.uuid() }),
  async execute(input, ctx) {
    const actor = actorOf(ctx);
    if (!actor) return failed("Apps are built for a person, and no one asked here.");
    const copy = await conversationCopy(ctx, actor, input.dashboard_id);
    if ("error" in copy) return failed(copy.error);
    const started = Date.now();
    let check: dashboards.RenderCheck | null = null;
    for (;;) {
      check = await ctx.deps.withTenant(ctx.run.orgId, (tx) => dashboards.renderCheckOf(tx, actor, copy.id));
      // Every width measured with its answers in: a width measured while they loaded is measured again by the browser.
      const widths = Object.values(check?.widths ?? {});
      if (widths.length >= 3 && widths.every((w) => !w.unsettled)) break;
      if (Date.now() - started > CHECK_WAIT_MS) break;
      await new Promise((r) => setTimeout(r, CHECK_EVERY_MS));
    }
    if (!check) {
      return {
        value: {
          measured: false,
          note: "No one has the App open to measure it yet. Read your files against react-app-craft's responsive rules instead, and say in the answer that its layout wasn't checked at every width.",
        },
        summary: { dashboardId: copy.id, measured: 0 },
      };
    }
    const verdict = renderVerdict(check);
    return { value: verdict, summary: { dashboardId: copy.id, measured: verdict.widths.length, found: verdict.found } };
  },
});

/**
 * What a render check says to the analyst. A width measured before its answers came in (a slow query or service) was
 * measured on loading states: nothing there is known clean, so it's said as unsettled and never counted as clean.
 */
export function renderVerdict(check: dashboards.RenderCheck) {
  const widths = Object.entries(check.widths).map(([width, w]) => ({
    width: Number(width),
    ...(w.unsettled ? { unsettled: true } : {}),
    findings: w.findings.filter((f) => f.kind !== "speed").map((f) => f.message),
  }));
  // How fast its numbers come is the same at every width: said once, not three times. It's advice, never counted as
  // found: one round sometimes has to wait (a record picked from a list's first row) and a query sometimes can't be
  // made cheaper, and a finding that can't be fixed would keep the App from ever being clean.
  const speed = [
    ...new Set(
      Object.values(check.widths).flatMap((w) => w.findings.filter((f) => f.kind === "speed").map((f) => f.message)),
    ),
  ];
  const found = widths.reduce((n, w) => n + w.findings.length, 0);
  const faster =
    " Under speed: make it faster where you can and save again; a round that has to wait and a query you can't make cheaper stay, said to the person in words, with no figure.";
  const unsettled = widths.filter((w) => w.unsettled).map((w) => w.width);
  const notes = [
    ...(widths.length < 3 ? ["Not every width was measured in time: check again after a moment."] : []),
    ...(unsettled.length
      ? [
          `At ${unsettled.join(", ")}px its answers were still loading when it was measured, so nothing there is known clean yet: call app_check again in a moment.`,
        ]
      : []),
  ];
  return {
    measured: true,
    widths,
    ...(speed.length ? { speed } : {}),
    found,
    ...(notes.length ? { note: notes.join(" ") } : {}),
    next:
      (found
        ? "Fix each finding (react-app-craft says how), save, and call app_check again."
        : unsettled.length
          ? "Not clean yet: some widths were measured before their answers came in. Call app_check again."
          : "Clean at every width measured.") + (speed.length ? faster : ""),
  };
}

export const DASHBOARD_TOOLS = [dashboardPlan, dashboardStart, dashboardSave, dashboardOpen, appCheck];

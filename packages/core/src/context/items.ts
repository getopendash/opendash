/**
 * Context: the glossary and guides, as governed items. A term says what one
 * of the business's words means, in words and, when it can, in the data; a guide is advice for the analyst, for the
 * whole workspace or one table, pinned to be always in front of it or found when relevant. Like definitions, each save
 * is a new version and only the version an admin approved (released_version) ever reaches the analyst; releases, which
 * pin a whole set, come with the eval gate.
 */
import { createHash } from "node:crypto";
import { isUuid, sql, type TenantTx, uuidv7 } from "@opendash/db";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { audit } from "../audit/write";
import { vectorSearch } from "../search/embeddings";
import { rrf } from "../search/rank";

const Slug = z.string().regex(/^[a-z0-9][a-z0-9_]*$/);

export const TermSpec = z.object({
  term: z.string().trim().min(1).max(80),
  means: z.string().trim().min(1).max(600),
  synonyms: z.array(z.string().trim().min(1).max(80)).max(12).default([]),
  /** Where the word lives in the data, when it does: a column (and values), or a verified metric. */
  maps_to: z
    .object({
      column: z
        .string()
        .regex(/^[A-Za-z_][\w]*\.[A-Za-z_][\w]*\.[A-Za-z_][\w]*$/, "schema.table.column")
        .optional(),
      values: z.array(z.string().max(120)).max(30).optional(),
      metric: Slug.optional(),
      note: z.string().max(300).optional(),
    })
    .optional(),
  /**
   * The tables it must never be read as: "Paying accounts" are not the trial accounts, kept in a table
   * of their own. On the item's source, as schema.table.
   */
  not: z
    .array(z.string().regex(/^[A-Za-z_][\w]*\.[A-Za-z_][\w]*$/, "schema.table"))
    .max(10)
    .optional(),
  /** Set by OpenDash when a learning made this version: its proposal, and the query that checked it. */
  learned: z.object({ proposalId: z.string(), checkQueryRunId: z.string().optional() }).optional(),
});
export type TermSpec = z.infer<typeof TermSpec>;

export const GuideSpec = z.object({
  title: z.string().trim().min(1).max(120),
  pinned: z.boolean().default(false),
  /** The table it's about (schema.table), on the item's source; none for the whole workspace. */
  table: z
    .string()
    .regex(/^[A-Za-z_][\w]*\.[A-Za-z_][\w]*$/, "schema.table")
    .optional(),
  /** Where it came from, when not written here: a correction someone gave on an answer. */
  from: z.object({ kind: z.literal("correction"), runId: z.string() }).optional(),
});
export type GuideSpec = z.infer<typeof GuideSpec>;

/**
 * A skill: a way of working for a kind of question. Its name and "use it when" line are in front of the
 * analyst on every question; it reads the steps (the body) when one fits, and follows them within its rules.
 */
export const SkillSpec = z.object({
  title: z.string().trim().min(1, "Give the skill a name.").max(120),
  /** When it applies, in a line: what the analyst matches a question against. */
  description: z
    .string()
    .trim()
    .min(1, "Say when the analyst should use it.")
    .max(300, "Keep “use it when” to one line (300 characters)."),
});
export type SkillSpec = z.infer<typeof SkillSpec>;

export type ContextKind = "term" | "guide" | "skill";

/** Pinned guides are always in the prompt, so they're kept short (org block). */
export const PINNED_GUIDE_MAX = 1_500;
export const GUIDE_MAX = 8_000;
/**
 * A skill is read as a file when it's relevant (in pages, from /skills), never pasted into every prompt, so it can be as
 * long as the method needs, well past a guide's 8,000 characters; the bound only keeps one from being a dump.
 */
export const SKILL_MAX = 100_000;

export class ContextProblem extends Error {
  constructor(
    readonly code: "invalid" | "not_found",
    message: string,
  ) {
    super(message);
  }
}

export const slugOf = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60) || "item";

export interface ContextSummary {
  id: string;
  kind: ContextKind;
  slug: string;
  title: string;
  connectionId: string | null;
  status: "draft" | "verified" | "needs_review" | "deprecated" | "proposed";
  version: number;
  releasedVersion: number | null;
  updatedAt: string;
  /** A term's meaning, or a guide's or a skill's first line. */
  summary: string;
  /** A skill's "use it when" line; null for the others. */
  useWhen: string | null;
  pinned: boolean;
  table: string | null;
  /** A guide proposed from someone's correction on an answer. */
  fromCorrection: boolean;
  synonyms: string[];
  mapsTo: TermSpec["maps_to"] | null;
}

export interface ContextDetail extends ContextSummary {
  body: string;
  spec: TermSpec | GuideSpec | SkillSpec;
  /** The version the analyst reads, when it differs from the current one. */
  released: { version: number; body: string; spec: TermSpec | GuideSpec | SkillSpec } | null;
  versions: { version: number; createdAt: string; changeNote: string | null; authorId: string | null }[];
}

type Row = {
  id: string;
  kind: ContextKind;
  slug: string;
  title: string;
  connection_id: string | null;
  status: ContextSummary["status"];
  current_version: number;
  released_version: number | null;
  updated_at: string;
  body: string;
  spec: TermSpec | GuideSpec | SkillSpec;
};

/** The first line worth showing: headings unmarked, and not one that only repeats the title. */
const firstLine = (s: string, title = "") =>
  s
    .replace(/^#+\s*/gm, "")
    .split(/\n+/)
    .map((l) => l.trim())
    .find((l) => l && l.toLowerCase() !== title.trim().toLowerCase()) ?? "";

function summaryOf(r: Row): ContextSummary {
  const term = r.kind === "term" ? (r.spec as TermSpec) : null;
  const guide = r.kind === "guide" ? (r.spec as GuideSpec) : null;
  const skill = r.kind === "skill" ? (r.spec as SkillSpec) : null;
  return {
    id: r.id,
    kind: r.kind,
    slug: r.slug,
    title: r.title,
    connectionId: r.connection_id,
    status: r.status,
    version: r.current_version,
    releasedVersion: r.released_version,
    updatedAt: new Date(r.updated_at).toISOString(),
    summary: term ? term.means : firstLine(r.body, r.title).slice(0, 200),
    useWhen: skill?.description ?? null,
    pinned: guide?.pinned ?? false,
    table: guide?.table ?? null,
    fromCorrection: guide?.from?.kind === "correction",
    synonyms: term?.synonyms ?? [],
    mapsTo: term?.maps_to ?? null,
  };
}

const selectCurrent = sql`
  select i.id, i.kind, i.slug, i.title, i.connection_id, i.status, i.current_version, i.released_version, i.updated_at,
    v.body, v.spec
  from app.context_item i
  join app.context_item_version v on v.org_id = i.org_id and v.item_id = i.id and v.version = i.current_version`;

/** The glossary or the guides, by title. */
export async function listContext(tx: TenantTx, orgId: string, kind: ContextKind): Promise<ContextSummary[]> {
  const rows = await tx.execute<Row>(sql`
    ${selectCurrent}
    where i.org_id = ${orgId} and i.kind = ${kind} and i.deleted_at is null and i.scope = 'org'
    order by lower(i.title)`);
  return rows.map(summaryOf);
}

/** One term, guide or skill: its current version, the released one when they differ, and its versions. */
export async function getContextItem(tx: TenantTx, orgId: string, id: string): Promise<ContextDetail | null> {
  if (!isUuid(id)) return null;
  const [r] = await tx.execute<Row>(sql`
    ${selectCurrent}
    where i.org_id = ${orgId} and i.id = ${id} and i.kind in ('term', 'guide', 'skill') and i.deleted_at is null`);
  if (!r) return null;
  const versions = await tx.execute<{
    version: number;
    created_at: string;
    change_note: string | null;
    author_id: string | null;
    body: string;
    spec: TermSpec | GuideSpec | SkillSpec;
  }>(sql`
    select version, created_at, change_note, author_id, body, spec from app.context_item_version
    where org_id = ${orgId} and item_id = ${id} order by version desc`);
  const released =
    r.released_version !== null && r.released_version !== r.current_version
      ? versions.find((v) => v.version === r.released_version)
      : null;
  return {
    ...summaryOf(r),
    body: r.body,
    spec: r.spec,
    released: released ? { version: released.version, body: released.body, spec: released.spec } : null,
    versions: versions.map((v) => ({
      version: v.version,
      createdAt: new Date(v.created_at).toISOString(),
      changeNote: v.change_note,
      authorId: v.author_id,
    })),
  };
}

/** Parses a term's YAML, or says what's wrong with it in words. */
export function parseTerm(body: string): { ok: true; spec: TermSpec } | { ok: false; problems: string[] } {
  let raw: unknown;
  try {
    raw = parseYaml(body);
  } catch (error) {
    return {
      ok: false,
      problems: [`This isn't valid YAML: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
  const parsed = TermSpec.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, problems: parsed.error.issues.map((i) => `${i.path.join(".") || "term"}: ${i.message}`) };
  }
  return { ok: true, spec: parsed.data };
}

/**
 * Writes a new version of an item (new or existing), as a draft until an admin approves it. Internal to the context
 * store (verified.ts writes verified queries through it too).
 */
export async function writeVersion(
  tx: TenantTx,
  ctx: { orgId: string; userId: string | null },
  input: {
    id?: string;
    kind: ContextKind | "verified_query" | "goal";
    title: string;
    slug: string;
    connectionId: string | null;
    body: string;
    spec: TermSpec | GuideSpec | Record<string, unknown>;
    changeNote?: string;
    /** A starter pack proposes; a person drafts. */
    proposed?: boolean;
    /** Who wrote the version, when not what `proposed` implies: a person's correction is proposed but theirs. */
    source?: "user" | "pack";
  },
): Promise<{ id: string; version: number }> {
  if (input.connectionId !== null && !isUuid(input.connectionId)) {
    throw new ContextProblem("invalid", "That source doesn't exist.");
  }
  let existing: { id: string; current_version: number; last: number } | undefined;
  if (input.id) {
    if (!isUuid(input.id)) throw new ContextProblem("not_found", "That doesn't exist.");
    // `last`: its highest version written. current_version can go back (a reject, a revert), and a new version never
    // takes a number one already has.
    [existing] = await tx.execute<{ id: string; current_version: number; last: number }>(sql`
      select i.id, i.current_version,
        (select coalesce(max(v.version), 0) from app.context_item_version v
          where v.org_id = i.org_id and v.item_id = i.id)::int as last
      from app.context_item i
      where i.org_id = ${ctx.orgId} and i.id = ${input.id} and i.kind = ${input.kind} and i.deleted_at is null
      for update of i`);
    if (!existing) throw new ContextProblem("not_found", "That doesn't exist.");
  }
  const [clash] = await tx.execute<{ id: string }>(sql`
    select id from app.context_item
    where org_id = ${ctx.orgId} and kind = ${input.kind} and slug = ${input.slug} and scope = 'org'
      and deleted_at is null and id is distinct from ${existing?.id ?? null}`);
  if (clash) {
    throw new ContextProblem(
      "invalid",
      input.kind === "verified_query"
        ? "There's already a verified query for that question."
        : `There's already a ${input.kind} called that.`,
    );
  }
  const id = existing?.id ?? uuidv7();
  const version = Math.max(existing?.current_version ?? 0, existing?.last ?? 0) + 1;
  const path =
    input.kind === "term"
      ? `/glossary/${input.slug}.yaml`
      : input.kind === "guide"
        ? `/guides/org/${input.slug}.md`
        : input.kind === "skill"
          ? `/skills/${input.slug}/SKILL.md`
          : input.kind === "goal"
            ? `/goals/${input.slug}.yaml`
            : `/verified/${input.slug}.md`;
  if (existing) {
    // The released version keeps answering until this one is approved.
    await tx.execute(sql`
      update app.context_item set current_version = ${version}, title = ${input.title}, slug = ${input.slug},
        path = ${path}, connection_id = ${input.connectionId}, status = ${input.proposed ? "proposed" : "draft"},
        updated_at = now()
      where org_id = ${ctx.orgId} and id = ${id}`);
  } else {
    await tx.execute(sql`
      insert into app.context_item (org_id, id, kind, connection_id, path, slug, title, owner_id, status,
        current_version)
      values (${ctx.orgId}, ${id}, ${input.kind}, ${input.connectionId}, ${path}, ${input.slug}, ${input.title},
        ${ctx.userId}, ${input.proposed ? "proposed" : "draft"}, 1)`);
  }
  await tx.execute(sql`
    insert into app.context_item_version (org_id, item_id, version, body, body_hash, spec, source, author_id,
      change_note)
    values (${ctx.orgId}, ${id}, ${version}, ${input.body}, ${createHash("sha256").update(input.body).digest("hex")},
      ${JSON.stringify(input.spec)}::jsonb, ${input.source ?? (input.proposed ? "pack" : "user")}, ${ctx.userId},
      ${input.changeNote?.trim() || null})`);
  return { id, version };
}

/** Saves a term from its YAML. A column mapping is checked against the source's learned catalog. */
export async function saveTerm(
  tx: TenantTx,
  ctx: { orgId: string; userId: string | null },
  input: { id?: string; body: string; connectionId?: string | null; changeNote?: string; proposed?: boolean },
): Promise<{ id: string; version: number }> {
  const parsed = parseTerm(input.body);
  if (!parsed.ok) throw new ContextProblem("invalid", parsed.problems.join(" "));
  const spec = parsed.spec;
  const onSource = Boolean(spec.maps_to?.column || spec.maps_to?.metric || spec.not?.length);
  const connectionId = onSource ? (input.connectionId ?? null) : null;
  if (onSource && !connectionId) {
    throw new ContextProblem("invalid", "Say which source the mapping is about.");
  }
  if (connectionId && !isUuid(connectionId)) throw new ContextProblem("invalid", "That source doesn't exist.");
  if (spec.maps_to?.column && connectionId) {
    const [found] = await tx.execute<{ ok: boolean }>(sql`
      select true as ok from app.catalog_object
      where org_id = ${ctx.orgId} and connection_id = ${connectionId} and kind = 'column'
        and fq_name = ${spec.maps_to.column} and removed_at is null limit 1`);
    if (!found) throw new ContextProblem("invalid", `${spec.maps_to.column} isn't a column of that source.`);
  }
  for (const table of spec.not ?? []) {
    const [found] = await tx.execute<{ ok: boolean }>(sql`
      select true as ok from app.catalog_object
      where org_id = ${ctx.orgId} and connection_id = ${connectionId} and kind in ('table', 'view')
        and fq_name = ${table} and removed_at is null limit 1`);
    if (!found) throw new ContextProblem("invalid", `${table} isn't a table of that source.`);
  }
  return writeVersion(tx, ctx, {
    ...(input.id ? { id: input.id } : {}),
    kind: "term",
    title: spec.term,
    slug: slugOf(spec.term),
    connectionId,
    body: input.body,
    spec,
    ...(input.changeNote ? { changeNote: input.changeNote } : {}),
    ...(input.proposed ? { proposed: true } : {}),
  });
}

/** Saves a guide: a title, markdown advice, and where it applies. */
export async function saveGuide(
  tx: TenantTx,
  ctx: { orgId: string; userId: string },
  input: {
    id?: string;
    title: string;
    body: string;
    pinned?: boolean;
    connectionId?: string | null;
    table?: string | null;
    changeNote?: string;
  },
): Promise<{ id: string; version: number }> {
  const spec = GuideSpec.safeParse({
    title: input.title,
    pinned: input.pinned ?? false,
    ...(input.table ? { table: input.table } : {}),
  });
  if (!spec.success) throw new ContextProblem("invalid", spec.error.issues.map((i) => i.message).join(" "));
  const body = input.body.trim();
  if (!body) throw new ContextProblem("invalid", "Write what the analyst should know.");
  if (body.length > (spec.data.pinned ? PINNED_GUIDE_MAX : GUIDE_MAX)) {
    throw new ContextProblem(
      "invalid",
      spec.data.pinned
        ? `A pinned guide is always in the analyst's prompt: keep it under ${PINNED_GUIDE_MAX} characters.`
        : `Keep a guide under ${GUIDE_MAX} characters.`,
    );
  }
  if (spec.data.table && !input.connectionId) throw new ContextProblem("invalid", "Say which source the table is in.");
  if (spec.data.table && input.connectionId && isUuid(input.connectionId)) {
    const [found] = await tx.execute<{ ok: boolean }>(sql`
      select true as ok from app.catalog_object
      where org_id = ${ctx.orgId} and connection_id = ${input.connectionId} and kind in ('table', 'view')
        and fq_name = ${spec.data.table} and removed_at is null limit 1`);
    if (!found) throw new ContextProblem("invalid", `${spec.data.table} isn't a table of that source.`);
  }
  return writeVersion(tx, ctx, {
    ...(input.id ? { id: input.id } : {}),
    kind: "guide",
    title: spec.data.title,
    slug: slugOf(spec.data.title),
    connectionId: input.connectionId ?? null,
    body,
    spec: spec.data,
    ...(input.changeNote ? { changeNote: input.changeNote } : {}),
  });
}

/** Saves a skill: its name, when to use it, and its steps in Markdown. Whole workspace for now. */
export async function saveSkill(
  tx: TenantTx,
  ctx: { orgId: string; userId: string },
  input: { id?: string; title: string; description: string; body: string; changeNote?: string },
): Promise<{ id: string; version: number }> {
  const spec = SkillSpec.safeParse({ title: input.title, description: input.description });
  if (!spec.success) throw new ContextProblem("invalid", spec.error.issues.map((i) => i.message).join(" "));
  const body = input.body.trim();
  if (!body) throw new ContextProblem("invalid", "Write the steps the analyst should follow.");
  if (body.length > SKILL_MAX)
    throw new ContextProblem("invalid", `Keep a skill under ${SKILL_MAX.toLocaleString("en-US")} characters.`);
  const slug = slugOf(spec.data.title);
  // OpenDash's own skills have that folder (/skills/opendash/…): a team skill can't take it.
  if (slug === "opendash") throw new ContextProblem("invalid", "That name is OpenDash's own: give the skill another.");
  return writeVersion(tx, ctx, {
    ...(input.id ? { id: input.id } : {}),
    kind: "skill",
    title: spec.data.title,
    slug,
    connectionId: null,
    body,
    spec: spec.data,
    ...(input.changeNote ? { changeNote: input.changeNote } : {}),
  });
}

/**
 * Approves terms and guides at the versions the reviewer saw: each becomes the one the analyst reads. A version saved
 * since (by another admin) isn't approved unseen; it stays a draft. Returns the ids approved.
 */
export async function approveContext(
  tx: TenantTx,
  ctx: { orgId: string; userId: string },
  items: { id: string; version: number }[],
): Promise<string[]> {
  const valid = items.filter((i) => isUuid(i.id) && Number.isInteger(i.version) && i.version > 0);
  if (!valid.length) return [];
  const rows = await tx.execute<{ id: string; kind: string; title: string; version: number }>(sql`
    update app.context_item i set status = 'verified', released_version = i.current_version,
      verified_by = ${ctx.userId}, verified_at = now(), updated_at = now()
    from (values ${sql.join(
      valid.map((v) => sql`(${v.id}::uuid, ${v.version}::int)`),
      sql`, `,
    )}) as seen(id, version)
    where i.org_id = ${ctx.orgId} and i.id = seen.id and i.current_version = seen.version
      and i.kind in ('term', 'guide', 'skill') and i.deleted_at is null and i.status in ('draft', 'proposed', 'needs_review')
    returning i.id, i.kind, i.title, i.current_version as version`);
  for (const r of rows) {
    await audit(tx, {
      action: "knowledge.approved",
      actor: { type: "user", id: ctx.userId },
      target: { type: "knowledge", id: r.id, name: r.title },
      detail: { kind: r.kind, version: r.version },
    });
  }
  return rows.map((r) => r.id);
}

/** Deletes a term, guide, skill, goal or verified query: it stops reaching the analyst (and Home) at once. */
export async function deleteContextItem(tx: TenantTx, orgId: string, id: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  const rows = await tx.execute(sql`
    update app.context_item set deleted_at = now()
    where org_id = ${orgId} and id = ${id} and kind in ('term', 'guide', 'skill', 'verified_query', 'goal')
      and deleted_at is null
    returning id`);
  return rows.length > 0;
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
// What the analyst reads: released versions only.

export interface ReleasedTerm {
  id: string;
  version: number;
  spec: TermSpec;
  /**
   * Released by the learning rule (two people said it), approved by no one: given as learned from the
   * team's corrections, never as an admin's word. A learning's test gives its candidate the same way.
   */
  learned: boolean;
}
export interface ReleasedGuide {
  id: string;
  version: number;
  title: string;
  body: string;
  pinned: boolean;
  table: string | null;
}

/**
 * One item the analyst was given or found, at its version (a run's record, the Context tab). A verified query is given
 * when it matches the question, and `followed` once the run's metric query computed the same metrics.
 */
export interface ContextUse {
  id: string;
  kind: ContextKind | "verified_query" | "memory" | "metric" | "dataset" | "dashboard" | "app";
  /** Empty for a memory: a shared conversation's readers never see the asker's memory. */
  title: string;
  version: number;
  /** `attached`: the asker attached it to a question in this conversation; `read`: a skill it followed. */
  how: "glossary" | "pinned" | "table" | "search" | "question" | "yours" | "attached" | "read";
  followed?: boolean;
  /** A skill's draft an owner or admin tried before approving it, or a metric's or dataset's not released. */
  draft?: boolean;
}

const released = (orgId: string, connectionId: string, kinds: string[] = ["term", "guide"]) => sql`
  select i.id, i.kind, i.title, i.path, v.version, v.body, v.spec,
    (i.kind = 'term' and i.verified_by is null) as learned from app.context_item i
  join app.context_item_version v on v.org_id = i.org_id and v.item_id = i.id and v.version = i.released_version
  where i.org_id = ${orgId} and i.kind in (${sql.join(
    kinds.map((k) => sql`${k}`),
    sql`, `,
  )}) and i.deleted_at is null and i.scope = 'org'
    and i.released_version is not null
    and (i.connection_id is null or i.connection_id = ${connectionId})`;

/** A released skill as the catalogue lists it: its name and when to use it. */
export interface ReleasedSkill {
  id: string;
  version: number;
  title: string;
  description: string;
  /** Where the knowledge folder has its steps: /skills/<slug>/SKILL.md. */
  path: string;
}

/**
 * The run's context: every released term, the pinned guides, the guides anchored to tables, and the skills'
 * catalogue (their steps are read from the knowledge folder, `releasedFiles`).
 */
export async function contextForRun(
  tx: TenantTx,
  orgId: string,
  connectionId: string,
  /** A learning's test: this unreleased version of a term, given in place of its released one, if any. */
  candidate: { itemId: string; version: number } | null = null,
): Promise<{ terms: ReleasedTerm[]; pinned: ReleasedGuide[]; anchored: ReleasedGuide[]; skills: ReleasedSkill[] }> {
  const rows = await tx.execute<{
    id: string;
    kind: ContextKind;
    title: string;
    path: string;
    version: number;
    body: string;
    spec: TermSpec | GuideSpec | SkillSpec;
    learned: boolean;
  }>(sql`${released(orgId, connectionId, ["term", "guide", "skill"])} order by i.kind, lower(i.title)`);
  let terms: ReleasedTerm[] = rows
    .filter((r) => r.kind === "term")
    .map((r) => ({ id: r.id, version: r.version, spec: r.spec as TermSpec, learned: r.learned }));
  if (candidate && isUuid(candidate.itemId)) {
    const [c] = await tx.execute<{ id: string; version: number; spec: TermSpec }>(sql`
      select i.id, v.version, v.spec from app.context_item i
      join app.context_item_version v on v.org_id = i.org_id and v.item_id = i.id and v.version = ${candidate.version}
      where i.org_id = ${orgId} and i.id = ${candidate.itemId} and i.kind = 'term' and i.scope = 'org'
        and i.deleted_at is null and (i.connection_id is null or i.connection_id = ${connectionId})`);
    if (c) terms = [...terms.filter((t) => t.id !== c.id), { ...c, learned: true }];
  }
  const guides = rows
    .filter((r) => r.kind === "guide")
    .map((r) => {
      const g = r.spec as GuideSpec;
      return { id: r.id, version: r.version, title: r.title, body: r.body, pinned: g.pinned, table: g.table ?? null };
    });
  const skills = rows
    .filter((r) => r.kind === "skill")
    .map((r) => ({
      id: r.id,
      version: r.version,
      title: r.title,
      description: (r.spec as SkillSpec).description,
      path: r.path,
    }));
  return {
    terms,
    pinned: guides.filter((g) => g.pinned),
    anchored: guides.filter((g) => !g.pinned && g.table),
    skills,
  };
}

/**
 * The corrections people reported on this source's answers that no admin has decided yet (proposed guides from a
 * correction), newest first: the Modeler reads them as reported by people, its drafts being reviewed anyway. A
 * released one is in the run's context already.
 */
export async function reportedCorrections(
  tx: TenantTx,
  orgId: string,
  connectionId: string,
  limit = 20,
): Promise<{ id: string; title: string; body: string }[]> {
  return tx.execute<{ id: string; title: string; body: string }>(sql`
    select i.id, i.title, v.body from app.context_item i
    join app.context_item_version v on v.org_id = i.org_id and v.item_id = i.id and v.version = i.current_version
    where i.org_id = ${orgId} and i.kind = 'guide' and i.deleted_at is null and i.scope = 'org'
      and i.released_version is null and i.status = 'proposed' and i.connection_id = ${connectionId}
      and v.spec->'from'->>'kind' = 'correction'
    order by i.updated_at desc limit ${limit}`);
}

/** A released item as the knowledge folder lists and reads it: by its path, at its released version. */
export type ReleasedFile = {
  id: string;
  kind: ContextKind | "verified_query" | "metric" | "dataset";
  title: string;
  path: string;
  version: number;
  body: string;
  /** A term the learning rule released, approved by no one (`ReleasedTerm.learned`). */
  learned: boolean;
};

/**
 * The released items of these kinds a run on this source may read, by path, under `under` (any case): what everyone in
 * the organization can read (org scope, released, not deleted), the source's own and those about no one source. A
 * draft, a deleted item and a person's own (a memory) are never among them.
 */
export async function releasedFiles(
  tx: TenantTx,
  orgId: string,
  connectionId: string,
  kinds: ReleasedFile["kind"][],
  under = "/",
): Promise<ReleasedFile[]> {
  return tx.execute<ReleasedFile>(sql`
    ${released(orgId, connectionId, kinds)} and starts_with(lower(i.path), lower(${under}))
    order by i.path`);
}

/**
 * Released terms, guides and verified queries matching a query: by their words (full text over their bodies, similar
 * titles, the phrase in a body) and, with the query's vector, by meaning, fused by reciprocal rank like every
 * search. Without a vector, by their words alone.
 */
export async function searchContext(
  tx: TenantTx,
  orgId: string,
  connectionId: string,
  query: string,
  limit = 5,
  vector?: { model: string; vector: number[] },
): Promise<
  {
    id: string;
    kind: ContextKind | "verified_query";
    title: string;
    version: number;
    body: string;
    learned: boolean;
    score: number;
  }[]
> {
  const q = query.trim().slice(0, 200);
  if (!q) return [];
  type Found = {
    id: string;
    kind: ContextKind | "verified_query";
    title: string;
    version: number;
    body: string;
    learned: boolean;
  };
  const words = await tx.execute<Found & { fts: number; sim: number; contains: boolean }>(sql`
    with r as (${released(orgId, connectionId, ["term", "guide", "verified_query"])}),
    m as (
      select id, kind, title, version, body, learned,
        ts_rank_cd(to_tsvector('english', title || ' ' || body), websearch_to_tsquery('english', ${q}))::float8 as fts,
        similarity(lower(title), lower(${q}))::float8 as sim,
        lower(body) like ${`%${q.toLowerCase().replace(/[%_]/g, "")}%`} as contains
      from r)
    select * from m where fts > 0 or sim > 0.3 or contains
    order by fts * 2 + sim desc limit 20`);
  const near = vector
    ? await vectorSearch(tx, vector, { kinds: ["term", "guide", "verified_query"], connectionId, limit: 20 })
    : [];
  const more = near.map((n) => n.id).filter((id) => !words.some((w) => w.id === id));
  const extra = more.length
    ? await tx.execute<Found>(sql`
        with r as (${released(orgId, connectionId, ["term", "guide", "verified_query"])})
        select id, kind, title, version, body, learned from r where id in (${sql.join(
          more.map((id) => sql`${id}`),
          sql`, `,
        )})`)
    : [];
  const byId = new Map<string, Found>([...words, ...extra].map((r) => [r.id, r]));
  const ranked = rrf([
    words
      .filter((w) => w.fts > 0)
      .sort((a, b) => b.fts - a.fts || b.sim - a.sim)
      .map((w) => w.id),
    words
      .filter((w) => w.sim > 0)
      .sort((a, b) => b.sim - a.sim || b.fts - a.fts)
      .map((w) => w.id),
    words.filter((w) => w.contains).map((w) => w.id),
    near.map((n) => n.id),
  ]);
  return [...ranked.entries()]
    .sort((a, b) => b[1] - a[1] || (byId.get(a[0])?.title ?? "").localeCompare(byId.get(b[0])?.title ?? ""))
    .flatMap(([id, score]) => {
      const r = byId.get(id);
      return r
        ? [{ id: r.id, kind: r.kind, title: r.title, version: r.version, body: r.body, learned: r.learned, score }]
        : [];
    })
    .slice(0, limit);
}

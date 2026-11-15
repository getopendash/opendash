/**
 * What a person attaches to a question: a released metric, dataset, guide or verified query of the conversation's
 * source, or a skill: released, or a draft
 * an owner or admin is trying (Try now). An owner or admin may attach a metric or dataset not released yet, and the
 * analyst may draft a change to one they attached. Attachments are checked when the question is asked, kept on its message, and given to
 * every run of the conversation, each checked again for whoever is asking then. A skill is kept at the version
 * chosen: the conversation follows that one, even if the skill changes meanwhile. A file is the
 * one attachment that isn't a reference: its text, as OpenDash's reader produced it, kept on the message as the
 * asker's data.
 */

import { createHash } from "node:crypto";
import type { Definition } from "@opendash/apps/dashboard";
import { SELECTED_TAG_MAX, selectedText, selectionLabel } from "@opendash/apps/select";
import { isUuid, sql, type TenantTx } from "@opendash/db";
import { dashboardEditableBy, dashboardReadableBy } from "../projects/access";
import type { Viewer } from "../runs/ledger";
import { imageType, MAX_IMAGE_BYTES } from "./reader";
import type { VerifiedQuerySpec } from "./verified";

export type AttachmentKind =
  | "metric"
  | "dataset"
  | "guide"
  | "verified_query"
  | "skill"
  | "file"
  | "image"
  | "dashboard"
  | "app_element";
export interface Attachment {
  kind: AttachmentKind;
  id: string;
  /** A skill's version: the released one unless an owner or admin is trying a draft. Set when it's checked. */
  version?: number;
  /**
   * A file's name and its text, as read (files only); an image's name, type and bytes (base64, images only). A piece
   * of an App: its chip's words (`name`, set when it's checked) and the element's own short text.
   */
  name?: string;
  text?: string;
  mediaType?: string;
  data?: string;
  /**
   * A piece of an App its owner selected (select to edit): the App, the revision they saw, and where the piece was
   * written (file, line, column) with its tag. Checked against that revision's stored files, which give `snippet`
   * (the lines around it, numbered, as they were) and `fileHash`; the selection is pinned to both.
   */
  dashboardId?: string;
  revision?: string;
  file?: string;
  line?: number;
  column?: number;
  tag?: string;
  snippet?: string;
  fileHash?: string;
}

/** The fields only a selected piece of an App carries. */
const ELEMENT_FIELDS = ["dashboardId", "revision", "file", "line", "column", "tag", "snippet", "fileHash"] as const;
/** The lines given either side of a selected piece's own. */
export const ELEMENT_CONTEXT_LINES = 10;

/** At most this many on one question. */
export const MAX_ATTACHMENTS = 5;
/** Files: at most this many on one question, each at most this much text. */
export const MAX_FILES = 3;
export const MAX_FILE_TEXT = 64 * 1024;
/** Images: at most this many on one question, each at most 2 MB (the reader's bound), and the newest few a run sees. */
export const MAX_IMAGES = 2;
const IMAGES_GIVEN = 4;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** Metrics, datasets, guides and verified queries a run is given from the whole conversation, newest first. */
const MAX_GIVEN = 10;

export class AttachmentProblem extends Error {}

/** One thing the composer's picker offers. */
export interface Attachable {
  kind: AttachmentKind;
  id: string;
  title: string;
  /** "6 blocks · yours", "Verified metric", "Guide · about invoices". */
  meta: string;
}

export type GivenAttachment =
  /**
   * A metric or dataset by its name, at the version Ask answers with (the current one while none is released). An
   * owner or admin who attached it may have the analyst draft a change to it: then its YAML now, the version
   * a draft is made on.
   */
  | {
      kind: "metric" | "dataset";
      id: string;
      title: string;
      version: number;
      name: string;
      released: boolean;
      editable: boolean;
      current?: { version: number; body: string; draft: boolean };
    }
  | { kind: "guide"; id: string; title: string; version: number; body: string }
  | { kind: "verified_query"; id: string; title: string; version: number; spec: VerifiedQuerySpec }
  /** A skill the asker chose for the question: its steps, at the version chosen; `draft` when it isn't released. */
  | { kind: "skill"; id: string; title: string; version: number; body: string; draft: boolean }
  /** A file the person attached: its text as OpenDash's reader produced it, the asker's data. */
  | { kind: "file"; id: string; title: string; text: string }
  /** An image the person attached: shown to the model with the question, as their own picture. */
  | { kind: "image"; id: string; title: string; mediaType: string; data: string }
  /**
   * A dashboard the person can read: its definition as they see it (its owner or an editor, the draft when
   * there's one; anyone else, the version published). `changeable` when the asker changes it (theirs, or shared with
   * them to edit) and they attached it: the analyst may change it from this conversation, not only the one it was
   * built in.
   */
  | {
      kind: "dashboard";
      id: string;
      /** Its title as published (a draft's rename stays its owner's); `draftTitle` is the draft's, for its owner. */
      title: string;
      draftTitle?: string;
      purpose: string | null;
      mine: boolean;
      /** Shared with the asker by name to edit its draft (not theirs, but theirs to change). */
      editor?: boolean;
      /** Shared beyond its owner: a private one's title isn't recorded where another reader could see it. */
      shared: boolean;
      /** The asker changes it (its owner, an editor) and attached it themselves. */
      changeable: boolean;
      /** The version published (0: none yet), and whether what's given is its owner's draft. */
      version: number;
      draft: boolean;
      definition: Definition | null;
      /** It came with the question this run answers: the App on screen when they asked (the panel beside it). */
      withQuestion: boolean;
    }
  /**
   * A piece of one of the asker's Apps they selected to change (select to edit): where it was written and the lines
   * around it as they were then, numbered. `changed` when the App has been saved since (the lines may have moved).
   */
  | {
      kind: "app_element";
      id: string;
      title: string;
      dashboardId: string;
      revision: string;
      file: string;
      line: number;
      tag: string;
      text: string;
      snippet: string;
      changed: boolean;
    };

const KIND_OF = { metric: "metric", guide: "guide", verified_query: "verified_query" } as const;
const DEFINITION_KINDS = new Set<AttachmentKind>(["metric", "dataset"]);

/** The released items of these kinds on the source the viewer can read (org scope), optionally by title. */
const releasedItems = (orgId: string, connectionId: string, kinds: string[], extra = sql``) => sql`
  select i.id, i.kind, i.title, i.slug, v.version, v.body, v.spec from app.context_item i
  join app.context_item_version v on v.org_id = i.org_id and v.item_id = i.id and v.version = i.released_version
  where i.org_id = ${orgId} and i.deleted_at is null and i.scope = 'org' and i.released_version is not null
    and i.kind in (${sql.join(
      kinds.map((k) => sql`${k}`),
      sql`, `,
    )})
    and (i.connection_id = ${connectionId} or (i.kind in ('guide', 'skill') and i.connection_id is null))
    -- Pinned guides go with every question already.
    and not (i.kind = 'guide' and coalesce((v.spec->>'pinned')::boolean, false))
    ${extra}`;

type ItemRow = {
  id: string;
  kind: "metric" | "dataset" | "guide" | "verified_query" | "skill";
  title: string;
  slug: string | null;
  version: number;
  body: string;
  spec: Record<string, unknown>;
};

/** What the viewer can attach to a question on this source, by kind; `q` narrows by title. */
export async function attachable(tx: TenantTx, viewer: Viewer, connectionId: string, q = ""): Promise<Attachable[]> {
  const like = `%${q
    .trim()
    .toLowerCase()
    .slice(0, 80)
    .replace(/[%_\\]/g, "")}%`;
  const items = await tx.execute<ItemRow>(sql`
    ${releasedItems(viewer.orgId, connectionId, ["metric", "dataset", "guide", "verified_query", "skill"], sql`and lower(i.title) like ${like}`)}
    order by lower(i.title)`);
  const out: Attachable[] = [];
  for (const kind of ["metric", "dataset", "guide", "verified_query", "skill"] as const) {
    for (const i of items.filter((x) => x.kind === kind).slice(0, 8)) {
      const table = typeof i.spec.table === "string" ? i.spec.table : null;
      out.push({
        kind,
        id: i.id,
        title: i.title,
        meta:
          kind === "metric"
            ? "Verified metric"
            : kind === "dataset"
              ? "Verified dataset"
              : kind === "guide"
                ? `Guide${table ? ` · about ${table}` : ""}`
                : kind === "skill"
                  ? "Skill · the analyst follows it for this question"
                  : "Verified query",
      });
    }
  }
  // Dashboards the viewer can open that read this source (as published, or as the draft has it for those who change
  // it).
  const boards = await tx.execute<{ id: string; title: string; mine: boolean; current_version: number }>(sql`
    select d.id, d.title, d.owner_id = ${viewer.userId}::uuid as mine, d.current_version from app.dashboard d
    left join app.dashboard_version v on v.org_id = d.org_id and v.dashboard_id = d.id and v.version = d.current_version
    left join app.dashboard_draft r on r.org_id = d.org_id and r.dashboard_id = d.id
      and ${dashboardEditableBy(viewer.userId)}
    where d.org_id = ${viewer.orgId} and d.deleted_at is null and ${dashboardReadableBy(viewer.userId)}
      and (d.current_version > 0 or ${dashboardEditableBy(viewer.userId)}) and lower(d.title) like ${like}
      and exists (
        select 1 from jsonb_each(coalesce(r.definition, v.definition, '{}'::jsonb)->'queries') q
        where q.value->'source'->>'connection' = ${connectionId})
    order by d.updated_at desc limit 8`);
  for (const d of boards) {
    out.push({
      kind: "dashboard",
      id: d.id,
      title: d.title,
      meta: `Dashboard · ${d.mine ? (d.current_version ? "yours" : "yours, a draft") : "shared with you"}`,
    });
  }
  return out;
}

/** These dashboards, those the viewer can open (a draft only for those who change it), by id. */
const readableDashboards = (tx: TenantTx, viewer: Viewer, ids: string[]) =>
  ids.length
    ? tx.execute<{
        id: string;
        title: string;
        purpose: string | null;
        mine: boolean;
        can_edit: boolean;
        shared: boolean;
        current_version: number;
      }>(sql`
        select d.id, d.title, d.purpose, d.owner_id = ${viewer.userId}::uuid as mine,
          ${dashboardEditableBy(viewer.userId)} as can_edit,
          -- Shared by its visibility: one shared with a few people by name is still private to everyone else who
          -- reads the conversation.
          d.visibility <> 'private' as shared, d.current_version
        from app.dashboard d
        where d.org_id = ${viewer.orgId} and d.deleted_at is null and ${dashboardReadableBy(viewer.userId)}
          and (d.current_version > 0 or ${dashboardEditableBy(viewer.userId)})
          and d.id in (${sql.join(
            ids.map((id) => sql`${isUuid(id) ? id : "00000000-0000-0000-0000-000000000000"}`),
            sql`, `,
          )})`)
    : Promise.resolve([]);

/** These lines of a file, numbered, the selected one marked: `  42 > <li …>`. */
export function numberedLines(source: string, line: number, around = ELEMENT_CONTEXT_LINES): string {
  const lines = source.split("\n");
  const first = Math.max(1, line - around);
  const last = Math.min(lines.length, line + around);
  const width = String(last).length;
  const out: string[] = [];
  for (let n = first; n <= last; n++) {
    out.push(`${String(n).padStart(width)} ${n === line ? ">" : "|"} ${lines[n - 1] ?? ""}`);
  }
  return out.join("\n");
}

/**
 * A piece of an App selected to change (select to edit) by someone who changes it (its owner, an editor), checked
 * against what's stored: the frame that sent it runs the App's own code, so every part of it is a claim. The asker
 * changes the App; its draft or one of its versions has the revision they saw; the file is one of that revision's
 * files; the line is in it. The lines around it are read from that stored file, never taken from the page; the chip's
 * words are made here.
 */
async function checkElement(tx: TenantTx, viewer: Viewer, a: Attachment): Promise<void> {
  const again = (why: string) => new AttachmentProblem(`${why}: select the piece of the App again.`);
  const { dashboardId, revision, file, line } = a;
  if (
    typeof dashboardId !== "string" ||
    !isUuid(dashboardId) ||
    typeof revision !== "string" ||
    !revision ||
    typeof file !== "string" ||
    !file.startsWith("/") ||
    typeof line !== "number" ||
    !Number.isInteger(line) ||
    line < 1
  ) {
    throw again("That selection is missing where it came from");
  }
  // Its owner, or someone it's shared with to edit.
  const [app] = viewer.userId
    ? await tx.execute<{ id: string }>(sql`
        select d.id from app.dashboard d
        where d.org_id = ${viewer.orgId} and d.id = ${dashboardId} and d.deleted_at is null
          and ${dashboardEditableBy(viewer.userId)}`)
    : [];
  if (!app) {
    throw new AttachmentProblem("Only those who change an App select a piece of it, and you don't change this one.");
  }
  const [drawn] = await tx.execute<{ has: boolean; source: string | null }>(sql`
    select true as has, parts->>${file} as source from app.dashboard_draft
    where org_id = ${viewer.orgId} and dashboard_id = ${dashboardId} and revision = ${revision}
    union all
    (select true as has, parts->>${file} as source from app.dashboard_version
      where org_id = ${viewer.orgId} and dashboard_id = ${dashboardId} and revision = ${revision}
      order by version desc limit 1)
    limit 1`);
  if (!drawn) throw again("The App has changed since that was drawn");
  if (typeof drawn.source !== "string") throw again(`The App has no file ${file.slice(0, 80)}`);
  if (line > drawn.source.split("\n").length) throw again(`${file} has no line ${line}`);
  const text = selectedText(a.text ?? "");
  const tag = typeof a.tag === "string" && /^[a-z][a-z0-9-]*$/i.test(a.tag) ? a.tag.slice(0, SELECTED_TAG_MAX) : "";
  a.text = text;
  a.tag = tag;
  if (typeof a.column !== "number" || !Number.isInteger(a.column) || a.column < 0) delete a.column;
  a.snippet = numberedLines(drawn.source, line);
  a.fileHash = createHash("sha256").update(drawn.source).digest("hex");
  a.name = selectionLabel({ file, text });
}

/**
 * The attachments a question may carry: each one the asker can read, on the conversation's source. Duplicates are
 * dropped. Throws AttachmentProblem, saying what's wrong, for anything else.
 */
export async function checkAttachments(
  tx: TenantTx,
  viewer: Viewer,
  connectionId: string,
  attachments: Attachment[],
  /** Owners and admins may try a skill's draft (any version of it); everyone else attaches released skills only. */
  options: { canTryDrafts?: boolean } = {},
): Promise<Attachment[]> {
  const seen = new Set<string>();
  const list = attachments.filter((a) => {
    // A piece of an App is the same selection wherever it's clicked again: by its App, revision, file and line.
    const key =
      a.kind === "app_element" ? `${a.kind}:${a.dashboardId}:${a.revision}:${a.file}:${a.line}` : `${a.kind}:${a.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (list.length > MAX_ATTACHMENTS)
    throw new AttachmentProblem(`Attach up to ${MAX_ATTACHMENTS} things to a question.`);
  const unavailable = () =>
    new AttachmentProblem(
      "Something you attached isn't available here: it was removed, isn't shared with you, or is about another source.",
    );
  if (list.some((a) => !isUuid(a.id))) throw unavailable();
  // Only a skill keeps a version, only a file a name and text; anything else is attached as itself.
  for (const a of list) {
    if (a.kind !== "skill") delete a.version;
    if (a.kind !== "file" && a.kind !== "image") delete a.name;
    // A selected piece keeps its own short text (bounded below); its snippet and hash are only ever the server's.
    if (a.kind !== "file" && a.kind !== "app_element") delete a.text;
    if (a.kind !== "image") {
      delete a.mediaType;
      delete a.data;
    }
    if (a.kind !== "app_element") for (const f of ELEMENT_FIELDS) delete a[f];
    else {
      delete a.snippet;
      delete a.fileHash;
    }
  }
  for (const a of list.filter((x) => x.kind === "app_element")) await checkElement(tx, viewer, a);
  // An image: its type is what its bytes say, within the reader's bound.
  const images = list.filter((a) => a.kind === "image");
  if (images.length > MAX_IMAGES) throw new AttachmentProblem(`Attach up to ${MAX_IMAGES} images to a question.`);
  for (const img of images) {
    const name = typeof img.name === "string" ? img.name.trim() : "";
    const plain = !/[/\\]/.test(name) && [...name].every((c) => c.charCodeAt(0) >= 32);
    if (!name || name.length > 120 || !plain || typeof img.data !== "string" || !IMAGE_TYPES.has(img.mediaType ?? "")) {
      throw new AttachmentProblem("An image needs a plain name, its type and its bytes.");
    }
    const bytes = Buffer.from(img.data, "base64");
    if (!bytes.byteLength || bytes.byteLength > MAX_IMAGE_BYTES || imageType(bytes) !== img.mediaType) {
      throw new AttachmentProblem(
        `An image is a PNG, JPEG, GIF or WebP of at most ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`,
      );
    }
    img.name = name;
  }
  const files = list.filter((a) => a.kind === "file");
  if (files.length > MAX_FILES) throw new AttachmentProblem(`Attach up to ${MAX_FILES} files to a question.`);
  for (const f of files) {
    const name = typeof f.name === "string" ? f.name.trim() : "";
    const plain = !/[/\\]/.test(name) && [...name].every((c) => c.charCodeAt(0) >= 32);
    if (!name || name.length > 120 || !plain || typeof f.text !== "string") {
      throw new AttachmentProblem("A file needs a plain name and its text.");
    }
    if (Buffer.byteLength(f.text, "utf8") > MAX_FILE_TEXT) {
      throw new AttachmentProblem(`A file's text is kept up to ${MAX_FILE_TEXT / 1024} KB.`);
    }
    f.name = name;
  }
  // A skill: the version asked for (the released one when none is), and only an owner or admin tries another.
  const skills = list.filter((x) => x.kind === "skill");
  for (const a of skills) {
    const [s] = await tx.execute<{ released_version: number | null; has: boolean }>(sql`
      select i.released_version, exists (
        select 1 from app.context_item_version v
        where v.org_id = i.org_id and v.item_id = i.id and v.version = ${a.version ?? -1}) as has
      from app.context_item i
      where i.org_id = ${viewer.orgId} and i.id = ${a.id} and i.kind = 'skill' and i.deleted_at is null
        and i.scope = 'org'`);
    if (!s) throw unavailable();
    if (a.version === undefined || a.version === s.released_version) {
      if (s.released_version === null) throw unavailable();
      a.version = s.released_version;
    } else if (!options.canTryDrafts || !Number.isInteger(a.version) || !s.has) {
      throw new AttachmentProblem(
        options.canTryDrafts
          ? "That version of the skill doesn't exist."
          : "Only owners and admins try a skill before it's approved.",
      );
    }
  }
  // A metric or dataset of this source: released, or (an owner or admin's) one not released yet.
  const definitions = list.filter((x) => DEFINITION_KINDS.has(x.kind));
  if (definitions.length) {
    const found = await definitionRows(
      tx,
      viewer.orgId,
      connectionId,
      definitions.map((d) => d.id),
    );
    for (const d of definitions) {
      const f = found.find((x) => x.id === d.id && x.kind === d.kind);
      if (!f || (f.released_version === null && !options.canTryDrafts)) throw unavailable();
    }
  }
  const others = list.filter((x) => x.kind === "guide" || x.kind === "verified_query");
  if (others.length) {
    const found = await tx.execute<{ id: string; kind: string }>(sql`
      ${releasedItems(
        viewer.orgId,
        connectionId,
        ["guide", "verified_query"],
        sql`and i.id in (${sql.join(
          others.map((o) => sql`${o.id}`),
          sql`, `,
        )})`,
      )}`);
    for (const o of others)
      if (!found.some((f) => f.id === o.id && f.kind === KIND_OF[o.kind as keyof typeof KIND_OF])) throw unavailable();
  }
  const boards = list.filter((x) => x.kind === "dashboard");
  if (boards.length) {
    const found = await readableDashboards(
      tx,
      viewer,
      boards.map((b) => b.id),
    );
    for (const b of boards) if (!found.some((f) => f.id === b.id)) throw unavailable();
  }
  return list;
}

/**
 * These metrics and datasets of the source, each with the version Ask answers with and its YAML now: released ones,
 * and ones not released yet unless deprecated.
 */
const definitionRows = (tx: TenantTx, orgId: string, connectionId: string, ids: string[]) =>
  tx.execute<{
    id: string;
    kind: "metric" | "dataset";
    title: string;
    slug: string;
    released_version: number | null;
    current_version: number;
    body: string;
  }>(sql`
    select i.id, i.kind, i.title, i.slug, i.released_version, i.current_version, v.body from app.context_item i
    join app.context_item_version v on v.org_id = i.org_id and v.item_id = i.id and v.version = i.current_version
    where i.org_id = ${orgId} and i.connection_id = ${connectionId} and i.deleted_at is null and i.scope = 'org'
      and i.kind in ('metric', 'dataset') and (i.released_version is not null or i.status <> 'deprecated')
      and i.id in (${sql.join(
        ids.map((id) => sql`${isUuid(id) ? id : "00000000-0000-0000-0000-000000000000"}`),
        sql`, `,
      )})`);

/**
 * What a run of this conversation is given: the latest ten attachments, each still readable by the asker and on the
 * conversation's source. `missing` counts the ones that no longer are.
 */
export async function conversationAttachments(
  tx: TenantTx,
  viewer: Viewer,
  threadId: string,
  connectionId: string,
  /** The asker may try drafts now (the run's, from when they asked): a draft they chose is given only then. */
  options: { canTryDrafts?: boolean } = {},
): Promise<{ items: GivenAttachment[]; missing: number }> {
  const rows = await tx.execute<{
    kind: AttachmentKind;
    id: string;
    version: number | null;
    author_id: string | null;
    name: string | null;
    text: string | null;
    media_type: string | null;
    data: string | null;
    latest: boolean;
  }>(sql`
    select a.value->>'kind' as kind, a.value->>'id' as id, (a.value->>'version')::int as version, m.author_id,
      -- On the question this run answers (the newest asked): what was on screen when they asked it.
      m.seq = (select max(q.seq) from app.message q where q.org_id = m.org_id and q.thread_id = m.thread_id
        and q.role = 'user' and q.status = 'complete') as latest,
      a.value->>'name' as name, a.value->>'text' as text, a.value->>'mediaType' as media_type,
      -- An image's bytes are read below, for the newest few only.
      null::text as data
    from app.message m, jsonb_array_elements(m.attachments) a
    -- A follow-up still queued isn't asked yet: its attachments are the next run's.
    where m.org_id = ${viewer.orgId} and m.thread_id = ${threadId} and m.role = 'user' and m.status = 'complete'
    order by m.seq desc`);
  const byKey = new Map<
    string,
    {
      kind: AttachmentKind;
      id: string;
      version: number | null;
      byAsker: boolean;
      name: string | null;
      text: string | null;
      mediaType: string | null;
      data: string | null;
      latest: boolean;
    }
  >();
  for (const r of rows) {
    const key = `${r.kind}:${r.id}`;
    const byAsker = viewer.userId !== null && r.author_id === viewer.userId;
    const had = byKey.get(key);
    // Newest first: a skill tried again at another version follows the latest one chosen.
    if (!had) {
      byKey.set(key, {
        kind: r.kind,
        id: r.id,
        version: r.version,
        byAsker,
        name: r.name,
        text: r.text,
        mediaType: r.media_type,
        data: r.data,
        latest: r.latest,
      });
    } else {
      if (byAsker) had.byAsker = true;
      if (r.latest) had.latest = true;
    }
  }
  const all = [...byKey.values()];
  const skills = all.filter((a) => a.kind === "skill");
  const files = all.filter((a) => a.kind === "file").slice(0, MAX_GIVEN);
  // The newest images only: each is sent with every question after it. Their bytes, for those alone.
  const images = all.filter((a) => a.kind === "image").slice(0, IMAGES_GIVEN);
  if (images.length) {
    const bytes = await tx.execute<{ id: string; data: string | null }>(sql`
      select a.value->>'id' as id, a.value->>'data' as data
      from app.message m, jsonb_array_elements(m.attachments) a
      where m.org_id = ${viewer.orgId} and m.thread_id = ${threadId} and m.role = 'user' and m.status = 'complete'
        and a.value->>'kind' = 'image' and a.value->>'id' in (${sql.join(
          images.map((i) => sql`${i.id}`),
          sql`, `,
        )})`);
    const byId = new Map(bytes.map((b) => [b.id, b.data]));
    for (const img of images) img.data = byId.get(img.id) ?? null;
  }
  const others = all
    // Only kinds there are: an attachment of a kind that's gone (an old dashboard's) is passed over.
    .filter(
      (a) =>
        a.kind === "metric" ||
        a.kind === "dataset" ||
        a.kind === "guide" ||
        a.kind === "verified_query" ||
        a.kind === "dashboard",
    )
    .slice(0, MAX_GIVEN);
  const items: GivenAttachment[] = [];
  let missing = 0;
  // A file is the asker's own data, kept with their message: given as it was read, newest first.
  for (const f of files) {
    if (f.name && typeof f.text === "string") items.push({ kind: "file", id: f.id, title: f.name, text: f.text });
    else missing++;
  }
  for (const img of images) {
    if (img.name && img.mediaType && img.data) {
      items.push({ kind: "image", id: img.id, title: img.name, mediaType: img.mediaType, data: img.data });
    } else missing++;
  }
  // A skill at the version chosen. A draft only for the one who chose it, and only while they may still try drafts
  // (checked on each question, as the asker's role may have changed): nobody follows a draft they couldn't choose.
  for (const a of skills) {
    const [s] =
      isUuid(a.id) && a.version !== null
        ? await tx.execute<{ title: string; body: string; released_version: number | null }>(sql`
            select i.title, v.body, i.released_version from app.context_item i
            join app.context_item_version v on v.org_id = i.org_id and v.item_id = i.id and v.version = ${a.version}
            where i.org_id = ${viewer.orgId} and i.id = ${a.id} and i.kind = 'skill' and i.deleted_at is null
              and i.scope = 'org'`)
        : [];
    const draft = Boolean(s) && s?.released_version !== a.version;
    if (!s || a.version === null || (draft && !(a.byAsker && options.canTryDrafts))) {
      missing++;
      continue;
    }
    items.push({ kind: "skill", id: a.id, title: s.title, version: a.version, body: s.body, draft });
  }
  // A metric or dataset: released, or, for an owner or admin who attached it, one not released yet. Theirs to have the
  // analyst draft a change to, while they may still edit definitions (checked on each question, as for a skill).
  const definitions = others.filter((a) => DEFINITION_KINDS.has(a.kind));
  const found = definitions.length
    ? await definitionRows(
        tx,
        viewer.orgId,
        connectionId,
        definitions.map((d) => d.id),
      )
    : [];
  for (const d of definitions) {
    const r = found.find((f) => f.id === d.id && f.kind === d.kind);
    const editable = d.byAsker && Boolean(options.canTryDrafts);
    if (!r || (r.released_version === null && !editable)) {
      missing++;
      continue;
    }
    items.push({
      kind: r.kind,
      id: r.id,
      title: r.title,
      version: r.released_version ?? r.current_version,
      name: r.slug,
      released: r.released_version !== null,
      editable,
      ...(editable
        ? {
            current: {
              version: r.current_version,
              body: r.body,
              draft: r.current_version !== r.released_version,
            },
          }
        : {}),
    });
  }
  // A dashboard, checked again for the asker: its owner or an editor is given the draft when there's one (what they're
  // looking at), anyone else the version published.
  const boards = others.filter((a) => a.kind === "dashboard");
  const readable = await readableDashboards(
    tx,
    viewer,
    boards.map((b) => b.id),
  );
  for (const b of boards) {
    const r = readable.find((f) => f.id === b.id);
    if (!r) {
      missing++;
      continue;
    }
    const [draft] = r.can_edit
      ? await tx.execute<{ definition: Definition }>(sql`
          select definition from app.dashboard_draft where org_id = ${viewer.orgId} and dashboard_id = ${r.id}`)
      : [];
    const [version] =
      !draft && r.current_version
        ? await tx.execute<{ definition: Definition }>(sql`
            select definition from app.dashboard_version
            where org_id = ${viewer.orgId} and dashboard_id = ${r.id} and version = ${r.current_version}`)
        : [];
    const definition = draft?.definition ?? version?.definition ?? null;
    items.push({
      kind: "dashboard",
      id: r.id,
      title: version?.definition?.title ?? r.title,
      ...(draft?.definition?.title ? { draftTitle: draft.definition.title } : {}),
      purpose: r.purpose,
      mine: r.mine,
      ...(r.can_edit && !r.mine ? { editor: true } : {}),
      shared: r.shared,
      // A change saves through this conversation's source: a dashboard reading another is changed beside it.
      // One they change (theirs, or shared to edit), attached by them: the analyst checks each query's source against
      // what the run can read when it saves.
      changeable: Boolean(r.can_edit) && b.byAsker,
      version: r.current_version,
      draft: Boolean(draft),
      definition,
      withQuestion: b.latest,
    });
  }
  // Pieces of an App selected to change: the newest few, each the asker's own selection of an App they still change.
  // Given as they were selected (the lines kept on the message, pinned to that revision), and said to have changed
  // when the App has been saved since.
  const elements = all.filter((a) => a.kind === "app_element").slice(0, MAX_ATTACHMENTS);
  const selected = elements.length
    ? await tx.execute<{ v: Attachment }>(sql`
        select a.value as v from app.message m, jsonb_array_elements(m.attachments) a
        where m.org_id = ${viewer.orgId} and m.thread_id = ${threadId} and m.role = 'user' and m.status = 'complete'
          and m.author_id is not distinct from ${viewer.userId}::uuid and a.value->>'kind' = 'app_element'
          and a.value->>'id' in (${sql.join(
            elements.map((e) => sql`${e.id}`),
            sql`, `,
          )})`)
    : [];
  const appIds = [...new Set(selected.map((s) => s.v.dashboardId).filter((id): id is string => isUuid(id ?? "")))];
  const apps =
    appIds.length && viewer.userId
      ? await tx.execute<{ id: string; revision: string | null }>(sql`
          select d.id, coalesce(r.revision, v.revision) as revision from app.dashboard d
          left join app.dashboard_draft r on r.org_id = d.org_id and r.dashboard_id = d.id
          left join app.dashboard_version v on v.org_id = d.org_id and v.dashboard_id = d.id
            and v.version = d.current_version
          where d.org_id = ${viewer.orgId} and d.deleted_at is null and ${dashboardEditableBy(viewer.userId)}
            and d.id in (${sql.join(
              appIds.map((id) => sql`${id}`),

              sql`, `,
            )})`)
      : [];
  for (const e of elements) {
    const v = selected.find((s) => s.v.id === e.id)?.v;
    const app = v ? apps.find((x) => x.id === v.dashboardId) : undefined;
    if (!v || !app || !v.file || !v.line || !v.revision || typeof v.snippet !== "string") {
      missing++;
      continue;
    }
    items.push({
      kind: "app_element",
      id: v.id,
      title: v.name ?? selectionLabel({ file: v.file, text: v.text ?? "" }),
      dashboardId: app.id,
      revision: v.revision,
      file: v.file,
      line: v.line,
      tag: v.tag ?? "",
      text: v.text ?? "",
      snippet: v.snippet,
      changed: app.revision !== v.revision,
    });
  }
  const rest = others.filter((a) => a.kind === "guide" || a.kind === "verified_query");
  if (rest.length) {
    const found = await tx.execute<ItemRow>(sql`
      ${releasedItems(
        viewer.orgId,
        connectionId,
        ["guide", "verified_query"],
        sql`and i.id in (${sql.join(
          rest.map((o) => sql`${isUuid(o.id) ? o.id : "00000000-0000-0000-0000-000000000000"}`),
          sql`, `,
        )})`,
      )}`);
    for (const o of rest) {
      const r = found.find((f) => f.id === o.id && f.kind === KIND_OF[o.kind as keyof typeof KIND_OF]);
      if (!r) {
        missing++;
        continue;
      }
      if (r.kind === "guide") items.push({ kind: "guide", id: r.id, title: r.title, version: r.version, body: r.body });
      else
        items.push({
          kind: "verified_query",
          id: r.id,
          title: r.title,
          version: r.version,
          spec: r.spec as unknown as VerifiedQuerySpec,
        });
    }
  }
  return { items, missing };
}

/**
 * "/skill:board_pack_mrr_bridge What moved MRR?" (a slash command): the question, with that released skill
 * attached. Null when the text isn't one; AttachmentProblem when the skill doesn't exist or no question follows.
 */
export async function skillCommand(
  tx: TenantTx,
  orgId: string,
  text: string,
): Promise<{ text: string; skill: Attachment } | null> {
  const m = /^\/skill:([A-Za-z0-9_-]+)\s*([\s\S]*)$/.exec(text.trim());
  if (!m) return null;
  const name = m[1] as string;
  const question = (m[2] ?? "").trim();
  const slug = name.toLowerCase().replace(/-/g, "_");
  const [s] = await tx.execute<{ id: string }>(sql`
    select id from app.context_item
    where org_id = ${orgId} and kind = 'skill' and slug = ${slug} and deleted_at is null and scope = 'org'
      and released_version is not null`);
  if (!s) throw new AttachmentProblem(`There's no approved skill called ${name}.`);
  if (!question) throw new AttachmentProblem(`Add your question after /skill:${name}.`);
  return { text: question, skill: { kind: "skill", id: s.id } };
}

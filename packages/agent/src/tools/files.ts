/**
 * What OpenDash knows, as a folder the agent reads: the way a coding agent reads a repository, a
 * short index in the prompt and the rest when it's needed. The tree is served from Postgres and the run's own sources,
 * never the host:
 *
 *   /README.md                                   what's here, and how to look
 *   /sources/<source>/README.md                  its database, its tables one line each, its metrics and models
 *   /sources/<source>/tables/<schema.table>.md   one table in detail, its category columns' common values read now
 *   /sources/<source>/metrics/<name>.yaml        a verified metric's definition
 *   /sources/<source>/models/<name>.yaml         a verified dataset's definition
 *   /glossary/<term>.yaml   /guides/org/<guide>.md   /verified/<query>.md   /skills/<skill>/SKILL.md
 *   /skills/opendash/<skill>/SKILL.md             OpenDash's own skills, which ship with the code
 *
 * The items are the team's, at the paths they're stored under (a source's definitions by its folder here, by its id
 * there): only released ones, at their released version, of the run's own source or of none. A path with nothing at
 * it and one the run can't read answer alike. Every page is fenced as data (a skill as a skill), and each item read is
 * recorded with its version, so the run's outcome says what it followed. A person's memory isn't here: it comes with
 * the conversation.
 */
import {
  BUDGETS,
  describeLiveValues,
  type ReleasedFile,
  releasedFiles,
  tablePatterns,
  threadResult,
} from "@opendash/core";
import { z } from "zod";
import {
  byUse,
  describedColumns,
  describeTable,
  findTable,
  folderOf,
  indexLine,
  tablesFolder,
  tableText,
} from "../instructions/catalog";
import {
  guideBlock,
  historyBlock,
  inert,
  skillBlock,
  termBlock,
  termsAboutTable,
  verifiedSearchBlock,
} from "../instructions/context";
import { BUILTIN_SKILLS, builtinId, builtinPath, REFERENCE_SKILLS, skillFile } from "../skills";
import { defineTool, type RunSource, type ToolContext } from "./types";

/** How much of a file one read returns, in characters, and how many entries one ls lists: the rest with `offset`. */
const PAGE = 24_000;
const ENTRIES = 400;
/** How many lines grep returns, and how long each may be. */
const MATCHES = 30;
const LINE = 200;

const ITEM_KINDS: ReleasedFile["kind"][] = ["term", "guide", "verified_query", "skill"];
const DEFINITIONS: Record<string, ReleasedFile["kind"]> = { metrics: "metric", models: "dataset" };
const definitionKind = (folder?: string) =>
  folder && Object.hasOwn(DEFINITIONS, folder) ? (DEFINITIONS[folder] as ReleasedFile["kind"]) : null;

const notFound = (path: string) => ({
  value: { error: `Nothing at ${path}. ls / shows what's here.` },
  summary: { path, failed: true },
});

/** A path's parts, or null for one that climbs (`..`). */
function partsOf(path: string): string[] | null {
  const parts = path.trim().split("/").filter(Boolean);
  return parts.some((p) => p === ".." || p === ".") ? null : parts;
}

/** The source a folder names: the run's own or one it can read. */
async function sourceAt(ctx: ToolContext, folder: string): Promise<RunSource | null> {
  const wanted = folder.toLowerCase();
  const names = [ctx.sources.main.name, ...ctx.sources.others.map((o) => o.name)];
  const name = names.find((n) => folderOf(n).toLowerCase() === wanted);
  return name ? ctx.sources.pick(name) : null;
}

type Item = ReleasedFile & { at: string; builtin?: true };

/** OpenDash's own skills, as items of the folder: at their path, fenced as OpenDash's. */
const BUILTINS: Item[] = [...BUILTIN_SKILLS, ...REFERENCE_SKILLS].flatMap((s) => [
  {
    id: builtinId(s),
    kind: "skill" as const,
    title: s.title,
    path: builtinPath(s),
    at: builtinPath(s),
    version: s.version,
    body: skillFile(s),
    learned: false,
    builtin: true as const,
  },
  // Its references, beside it in its folder.
  ...(s.references ?? []).map((r) => {
    const at = `${builtinPath(s).replace(/SKILL\.md$/, "")}${r.file}`;
    return {
      id: `${builtinId(s)}/${r.file}`,
      kind: "skill" as const,
      title: r.title,
      path: at,
      at,
      version: s.version,
      body: r.body,
      learned: false,
      builtin: true as const,
    };
  }),
]);

/**
 * The team's items the run may read under a path (`under`, as the tree names it): its source's, or, given a source,
 * that source's definitions under its folder. Only what's under the path is read.
 */
async function itemsOf(ctx: ToolContext, under = "/", source?: RunSource): Promise<Item[]> {
  const { deps, run } = ctx;
  if (source) {
    const own = `/sources/${source.connectionId}/`;
    const shown = `/sources/${folderOf(source.name)}/`;
    const stored = under.toLowerCase().startsWith(shown.toLowerCase()) ? own + under.slice(shown.length) : own;
    const defs = await deps.withTenant(run.orgId, (tx) =>
      releasedFiles(tx, run.orgId, source.connectionId, ["metric", "dataset"], stored),
    );
    return defs.map((d) => ({ ...d, at: shown + d.path.slice(own.length) }));
  }
  const items = await deps.withTenant(run.orgId, (tx) =>
    releasedFiles(tx, run.orgId, ctx.sources.main.connectionId, ITEM_KINDS, under),
  );
  const own = BUILTINS.filter((b) => b.at.toLowerCase().startsWith(under.toLowerCase()));
  return [...own, ...items.map((i) => ({ ...i, at: i.path }))];
}

/** An item's text as the model reads it, fenced by what it is: a page of its body at a time. */
function itemContent(i: Item, body = i.body): string {
  switch (i.kind) {
    case "term":
      return termBlock(body, i.learned);
    case "guide":
      return guideBlock({ title: i.title, body });
    case "verified_query":
      return verifiedSearchBlock(body);
    case "skill":
      return skillBlock({ ...i, body }, i.builtin ? "opendash" : undefined);
    default:
      return `<context source="verified ${i.kind === "dataset" ? "model" : "metric"}" trust="admin">\n${inert(body)}\n</context>`;
  }
}

/** One page of a long text, fenced by `fence` page by page, and where the next one starts. */
function page(text: string, offset = 0, fence: (part: string) => string = (part) => part) {
  const part = text.slice(offset, offset + PAGE);
  const next = offset + part.length;
  return {
    content: fence(part),
    ...(next < text.length ? { more: `read it again with offset ${next} for the rest` } : {}),
  };
}

/** Text from the source's own database (names, comments), fenced as data. */
const asData = (text: string) => `<context source="what OpenDash knows" trust="data">\n${inert(text)}\n</context>`;

const README = `What OpenDash knows about your organization's data, as files. Read one with read, list a folder with ls, find a word with grep.

- /sources/<source>/: each source the conversation can read: its tables (tables/<schema.table>.md: columns, joins, the common values of its category columns), its verified metrics (metrics/<name>.yaml) and models (models/<name>.yaml).
- /glossary/: the business's words, approved by an admin or (trust="learned") learned from the team's corrections.
- /guides/: how the team works with the data.
- /verified/: questions an admin answered with a verified query.
- /skills/: ways of working, each for a kind of question: OpenDash's own (opendash/) and the ones the team approved.`;

/** A source's own page: its database, its definitions by name, its tables most read first. */
function sourceReadme(source: RunSource, definitions: Item[]): string {
  const named = (kind: string) =>
    definitions
      .filter((d) => d.kind === kind)
      .map((d) => d.at.split("/").pop())
      .join(", ") || "none";
  return [
    `# ${source.name} (${source.dialect.name})`,
    "",
    `Metrics (metrics/): ${named("metric")}`,
    `Models (models/): ${named("dataset")}`,
    "",
    `Tables (tables/), ${source.tables.length.toLocaleString("en-US")}, most read first:`,
    ...byUse(source.tables).map(indexLine),
  ].join("\n");
}

/** A folder's entries: a sub-folder ends with a slash, a file names what it holds. */
async function listing(ctx: ToolContext, parts: string[]): Promise<string[] | null> {
  const [top, folder, sub, ...rest] = parts;
  if (!top) {
    const items = await itemsOf(ctx);
    const count = (prefix: string) => items.filter((i) => i.at.startsWith(prefix)).length;
    return [
      "README.md",
      `sources/ (${1 + ctx.sources.others.length})`,
      ...(["glossary", "guides", "verified", "skills"] as const).flatMap((d) =>
        count(`/${d}/`) ? [`${d}/ (${count(`/${d}/`)})`] : [],
      ),
    ];
  }
  if (top === "sources") {
    if (!folder) return [ctx.sources.main.name, ...ctx.sources.others.map((o) => o.name)].map((n) => `${folderOf(n)}/`);
    const source = await sourceAt(ctx, folder);
    if (!source || rest.length) return null;
    if (!sub) {
      const defs = await itemsOf(ctx, `/sources/${folderOf(source.name)}/`, source);
      return [
        "README.md",
        `tables/ (${source.tables.length})`,
        `metrics/ (${defs.filter((d) => d.kind === "metric").length})`,
        `models/ (${defs.filter((d) => d.kind === "dataset").length})`,
      ];
    }
    if (sub === "tables") {
      return byUse(source.tables).map((t) => {
        const name = `${t.schema}.${t.name}`;
        return `${name}.md${indexLine(t).slice(name.length)}`;
      });
    }
    const kind = definitionKind(sub);
    if (!kind) return null;
    return (await itemsOf(ctx, `/sources/${folderOf(source.name)}/${sub}/`, source))
      .filter((d) => d.kind === kind)
      .map((d) => `${d.at.split("/").pop()} · ${d.title}`);
  }
  const prefix = `/${parts.join("/")}/`;
  const under = await itemsOf(ctx, prefix);
  if (!under.length) return null;
  const entries = new Map<string, string>();
  for (const i of under) {
    const [first, ...deeper] = i.at.slice(prefix.length).split("/");
    if (deeper.length) entries.set(`${first}/`, `${first}/`);
    else entries.set(first as string, `${first} · ${i.title}`);
  }
  return [...entries.values()];
}

export const ls = defineTool({
  name: "ls",
  effect: "read",
  description:
    "Lists a folder of what OpenDash knows: / for the top, /sources/<source>/tables for a source's tables (one line each, most read first).",
  schema: z.object({
    path: z.string().max(300).default("/").describe("A folder: /, /sources/billing/tables, /skills"),
    offset: z.number().int().min(0).optional().describe("Where to start, for a long folder's rest"),
  }),
  async execute(input, ctx) {
    const parts = partsOf(input.path);
    const entries = parts ? await listing(ctx, parts) : null;
    if (!entries) return notFound(input.path);
    const from = input.offset ?? 0;
    const shown = entries.slice(from, from + ENTRIES);
    const next = from + shown.length;
    return {
      value: {
        path: input.path,
        // Names and comments come from the source's own database and the team's titles: data.
        entries: asData(shown.join("\n")),
        ...(next < entries.length ? { more: `${entries.length - next} more: ls it again with offset ${next}` } : {}),
      },
      summary: { path: input.path, entries: entries.length },
    };
  },
});

export const read = defineTool({
  name: "read",
  effect: "read",
  description:
    "Reads one file of what OpenDash knows. A table's (/sources/<source>/tables/<schema.table>.md): its columns, joins and how sure they are, the tables that point at it, its guides, the team's most-run queries of it, and its category columns' common values, read now. Also a verified metric or model, a glossary term, a guide, a verified query, or a skill's steps. And /results/q3: an earlier query's rows again, without running it.",
  schema: z.object({
    path: z
      .string()
      .max(300)
      .describe("A file: /sources/billing/tables/public.invoices.md, /skills/churn-review/SKILL.md"),
    offset: z.number().int().min(0).optional().describe("Where to start, for a long file's rest"),
  }),
  async execute(input, ctx, call) {
    const parts = partsOf(input.path);
    if (!parts?.length) return notFound(input.path);
    if (parts[0] === "results" && parts.length === 2)
      return resultFile(ctx, parts[1] as string, input.path, input.offset);
    if (parts.length === 1 && parts[0] === "README.md") {
      return { value: { path: input.path, ...page(README, input.offset) } };
    }
    const wanted = `/${parts.join("/")}`.toLowerCase();
    const [top, folder, sub, file, ...rest] = parts;
    if (top === "sources" && folder) {
      const source = await sourceAt(ctx, folder);
      if (!source || rest.length) return notFound(input.path);
      if (sub === "README.md" && !file) {
        const defs = await itemsOf(ctx, `/sources/${folderOf(source.name)}/`, source);
        return { value: { path: input.path, ...page(sourceReadme(source, defs), input.offset, asData) } };
      }
      if (sub === "tables" && file?.endsWith(".md")) return tableFile(ctx, source, file.slice(0, -3), input.path, call);
      if (!definitionKind(sub) || !file) return notFound(input.path);
      const def = (await itemsOf(ctx, wanted, source)).find((d) => d.at.toLowerCase() === wanted);
      return def ? itemFile(def, input.path, input.offset) : notFound(input.path);
    }
    const item = (await itemsOf(ctx, wanted)).find((i) => i.at.toLowerCase() === wanted);
    return item ? itemFile(item, input.path, input.offset) : notFound(input.path);
  },
});

/**
 * The rows read back: the ones its query showed, which are the ones an answer can cite (the gate checks references
 * against them); more need a narrower query.
 */
const RESULT_ROWS = BUDGETS.agent.rowsToModel;

/**
 * An earlier result of this conversation, read back from what the gateway kept (its first rows), its rows numbered as
 * they were, so a reference to them stays the same. Nothing runs on the source.
 */
async function resultFile(ctx: ToolContext, alias: string, path: string, offset = 0) {
  if (!/^q\d{1,6}$/.test(alias)) return notFound(path);
  const r = await threadResult(ctx.deps, ctx.run, alias);
  if (!r) return notFound(path);
  const columns = r.result_schema ?? [];
  const kept = (r.preview ?? []).slice(0, RESULT_ROWS);
  const from = Math.min(offset, kept.length);
  const shown = kept.slice(from, from + RESULT_ROWS);
  const next = from + shown.length;
  const rows = shown.map((row, i) => {
    const o: Record<string, unknown> = { "#": from + i };
    columns.forEach((c, j) => {
      if (!(c.name in o)) o[c.name] = row[j];
    });
    return o;
  });
  const total = r.rows ?? kept.length;
  return {
    value: {
      path,
      alias: r.alias,
      ...(r.title ? { title: inert(r.title) } : {}),
      columns,
      // As a query gives them: the cells an answer cites.
      rows,
      rowCount: total,
      ...(next < kept.length ? { more: `Rows ${next}–${kept.length - 1} too: read it again with offset ${next}` } : {}),
      // Cut at the source's row cap when it ran: what's here isn't all of it.
      ...(r.truncated ? { truncated: true } : {}),
      ...(total > kept.length && next >= kept.length
        ? {
            past: `Only its first ${kept.length} rows can be read back and cited; for others, run a narrower query (a filter, an order, a limit).`,
          }
        : {}),
    },
    summary: { path, alias: r.alias, rows: shown.length },
  };
}

function itemFile(item: Item, path: string, offset?: number) {
  return {
    value: {
      path,
      title: inert(item.title),
      version: item.version,
      ...page(item.body, offset, (part) => itemContent(item, part)),
    },
    summary: {
      path,
      title: item.title,
      items: [{ id: item.id, kind: item.kind, title: item.title, version: item.version }],
    },
  };
}

/** One table in detail (what catalog_describe gave): its card, its guides, the team's most-run queries of it. */
async function tableFile(
  ctx: ToolContext,
  source: RunSource,
  name: string,
  path: string,
  call: { rowId: string; signal: AbortSignal },
) {
  const { deps, run, context } = ctx;
  const found = findTable(source.tables, name);
  // Not a table here: the closest names, so the model can read the right file.
  if (!found) return { value: describeTable(source.tables, name), summary: { path, table: name, failed: true } };
  const main = source === ctx.sources.main;
  const full = `${found.schema}.${found.name}`;
  // The table's own guides (the main source's: guides are given for it), fenced as data.
  const guides = main ? context.anchored.filter((g) => g.table?.toLowerCase() === full.toLowerCase()) : [];
  // The team's terms it is, and the ones it isn't (the main source's: terms are given for it).
  const terms = main ? termsAboutTable(context.terms, full) : null;
  const patterns = await deps.withTenant(run.orgId, (tx) =>
    tablePatterns(tx, run.orgId, source.connectionId, full.toLowerCase()),
  );
  const history = historyBlock(full, patterns);
  // Its category columns' values, read from the source now and not kept.
  const values = await describeLiveValues(ctx.gateway, {
    orgId: run.orgId,
    connectionId: source.connectionId,
    dialect: source.dialect.id,
    requester: ctx.requester,
    toolCallId: call.rowId,
    signal: call.signal,
    columns: describedColumns(found),
  });
  return {
    value: {
      path,
      table: describeTable(source.tables, full, values),
      ...(guides.length ? { guides: guides.map(guideBlock) } : {}),
      ...(terms ? { team_terms: terms } : {}),
      ...(history ? { how_your_team_queries_it: history } : {}),
    },
    summary: {
      path,
      table: full,
      ...(main ? {} : { source: source.name }),
      ...(guides.length ? { guides: guides.map((g) => ({ id: g.id, title: g.title, version: g.version })) } : {}),
      ...(patterns.length ? { patterns: patterns.length } : {}),
    },
  };
}

export const grep = defineTool({
  name: "grep",
  effect: "read",
  description:
    "Finds the lines that contain some words (any case) in what OpenDash knows, under a path or everywhere: a column or table name, a word from the question. For a value in the data (a customer, a country), use value_lookup.",
  schema: z.object({
    pattern: z.string().min(2).max(100).describe("The words to find, as written: invoice_id, churn, fiscal year"),
    path: z.string().max(300).optional().describe("Where to look: a folder, /sources/billing; everywhere by default"),
  }),
  async execute(input, ctx) {
    const parts = partsOf(input.path ?? "/");
    if (!parts) return notFound(input.path ?? "/");
    const scope = `/${parts.join("/")}`;
    // The path itself or what's under it: /skills/opendash is that folder, not /skills/opendash_x too.
    const within = (path: string) => {
      const p = path.toLowerCase();
      const s = scope.toLowerCase();
      return s === "/" || p === s || p.startsWith(`${s}/`);
    };
    // The sources it searches: the one the path names, else the run's own (others when named: they load in full).
    const named = parts[0] === "sources" && parts[1] ? await sourceAt(ctx, parts[1]) : null;
    if (parts[0] === "sources" && parts[1] && !named) return notFound(input.path ?? "/");
    const files: { path: string; text: () => string }[] = [];
    if (scope === "/" || parts[0] === "sources") {
      for (const source of named ? [named] : [ctx.sources.main]) {
        for (const t of source.tables) {
          const path = `${tablesFolder(source.name)}/${t.schema}.${t.name}.md`;
          if (within(path)) files.push({ path, text: () => tableText(t) });
        }
        for (const d of await itemsOf(ctx, named ? scope : `/sources/${folderOf(source.name)}/`, source)) {
          files.push({ path: d.at, text: () => d.body });
        }
      }
    }
    if (!named && parts[0] !== "sources") {
      // OpenDash's own skills only when it searches the skills: their examples aren't the organization's data.
      const skills = scope.toLowerCase().startsWith("/skills");
      for (const i of await itemsOf(ctx, scope)) {
        if (within(i.at) && (skills || !i.builtin)) files.push({ path: i.at, text: () => `${i.title}\n${i.body}` });
      }
    }
    const needle = input.pattern.trim().toLowerCase();
    const matches: string[] = [];
    let more = 0;
    for (const f of files) {
      for (const line of f.text().split("\n")) {
        if (!line.toLowerCase().includes(needle)) continue;
        if (matches.length >= MATCHES) {
          more += 1;
          continue;
        }
        const text = line.trim();
        matches.push(`${f.path}: ${text.length > LINE ? `${text.slice(0, LINE - 1)}…` : text}`);
      }
    }
    return {
      value: {
        pattern: input.pattern,
        // Names, comments and the team's text: data, fenced like the rest of it.
        matches: matches.length
          ? asData(matches.join("\n"))
          : "No lines contain that. Try other words, or ls a folder.",
        ...(more ? { more: `${more} more lines match: narrow it with path` } : {}),
      },
      summary: { pattern: input.pattern, ...(input.path ? { path: input.path } : {}), matches: matches.length + more },
    };
  },
});

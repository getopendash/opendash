/**
 * What mcp_find shows the model of a workspace's connected services, decided from every server and usable tool
 * (core mcp.findTools) with no database, so it is tested alone. Every result starts with every server turned on, a
 * line each, so none can go missing: a missing one reads as one that isn't connected. Then as much of the tools as the
 * call asks for, and never more, since a workspace's tools run to hundreds and the result stays in the conversation:
 *   - nothing asked: each server's tool names;
 *   - a server_id: that server's tools, each with what it does in a sentence;
 *   - a query: the tools that match it best, ranked, each whole (all its description, all its input).
 * Names, titles and descriptions are what services wrote: data, never instructions.
 */
import type { mcp } from "@opendash/core";
import { inert } from "../instructions/context";

/** Tool names shown for each server when nothing is asked; past them, how many more. */
const NAMES_PER_SERVER = 60;
/** What a tool does, when a server's tools are listed: its first sentence, at most this long. */
const BRIEF_CHARS = 160;
/** A server's listing at most; past it, the rest are listed by name and title only. */
const LIST_CHARS = 24_000;
/** Tools a search shows whole; naming tools shows each named, up to the most. */
const MATCHES = 8;
const MOST_MATCHES = 15;
/** More matches, by name only, after the whole ones. */
const ALSO = 10;
/** A search's whole tools at most; past it, lower-ranked ones move to the names (never cut). */
export const SEARCH_CHARS = 40_000;
/** A match is shown whole only when it scores at least this share of the best one. */
const FLOOR = 0.4;
/** Matches within this share of the best are ones the words can't tell apart. */
const NEAR = 0.9;
/** A word's weight in a tool's name, title and description: a tool is what its name says first. */
const WEIGHTS = { name: 3, title: 2, description: 1 } as const;
/** A word that only starts the other (cost and costs) fits less than the same word. */
const PREFIX = 0.8;

const STATE_WORDS: Record<mcp.FoundServer["state"], string> = {
  ready: "ready",
  connect: "the person hasn't connected it: calling it shows them a Connect card",
  reconnect: "its sign-in has to be done again: calling it shows a Connect card",
  wrong_account: "signed in as a different account: calling it shows a card to choose",
  needs_person: "uses each person's own account, so it can't be used here",
};

const NOT_USABLE = "it can delete or overwrite, and OpenDash never calls that";

/** Words that say nothing about what a tool does: left out of a query (`in`, `the`, and the words for tools). */
const STOP = new Set(
  (
    "a an the of for by to in on at and or is are was were be been me my our we us i you it its this that these those " +
    "what which who how much many with from per do does did can could about each all any some there then than " +
    "tool tools service services server servers mcp connected"
  ).split(" "),
);

/**
 * A name's or a text's words, lowercased, with snake_case, kebab-case and camelCase taken apart (getLLMCosts is get,
 * llm, costs), so a query's words meet a tool's however it is written.
 */
export function wordsOf(text: string): string[] {
  return text
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * A tool's input as the service lists it (JSON Schema), whole: the agent calls it right only from all of it, not
 * from one cut down (arguments' descriptions to 100 characters, their values to 8, the whole to 1,200).
 */
const fullSchema = (schema: Record<string, unknown>): string => JSON.stringify(schema);

/** What a tool does in a sentence: its first one, at most BRIEF_CHARS, cut at a word. */
function brief(text: string | null): string | null {
  if (!text) return null;
  const flat = text.replace(/\s+/g, " ").trim();
  const sentence = /^.{20,}?[.!?](?=\s|$)/u.exec(flat)?.[0] ?? flat;
  if (sentence.length <= BRIEF_CHARS) return sentence;
  const cut = sentence.slice(0, BRIEF_CHARS - 1);
  const space = cut.lastIndexOf(" ");
  return `${space > BRIEF_CHARS / 2 ? cut.slice(0, space) : cut}…`;
}

interface Entry {
  server: mcp.FoundServer;
  tool: mcp.FoundTool;
  fields: { words: Set<string>; weight: number }[];
}

interface Ranked {
  entry: Entry;
  score: number;
}

const entriesOf = (servers: mcp.FoundServer[]): Entry[] =>
  servers.flatMap((server) =>
    server.tools.map((tool) => ({
      server,
      tool,
      fields: [
        { words: new Set(wordsOf(tool.name)), weight: WEIGHTS.name },
        { words: new Set(wordsOf(tool.title ?? "")), weight: WEIGHTS.title },
        { words: new Set(wordsOf(tool.description ?? "")), weight: WEIGHTS.description },
      ],
    })),
  );

/** How well a query word fits a tool: the best of its fields, by weight, the same word or one starting the other. */
function fitOf(entry: Entry, word: string): number {
  let best = 0;
  for (const field of entry.fields) {
    if (field.weight <= best) continue;
    if (field.words.has(word)) best = field.weight;
    else if (word.length >= 4 && field.weight * PREFIX > best) {
      for (const w of field.words) {
        if (w.length >= 4 && (w.startsWith(word) || word.startsWith(w))) {
          best = field.weight * PREFIX;
          break;
        }
      }
    }
  }
  return best;
}

/**
 * The tools that fit the words, best first. Each word counts by how rare it is among the workspace's tools (an IDF:
 * `get`, `list` and `search` are in most and count little), times where it fits (a name over a title over a
 * description); a tool's sum is then scaled by the share of the words it fits, so one that fits more of the question
 * ranks first. A tool that may delete or overwrite comes last: it's never called.
 */
function rank(entries: Entry[], words: string[], workspace: Entry[]): Ranked[] {
  const n = workspace.length;
  const weight = new Map(
    words.map((w) => {
      const df = workspace.filter((e) => fitOf(e, w) > 0).length;
      return [w, Math.log(1 + (n - df + 0.5) / (df + 0.5))];
    }),
  );
  return entries
    .map((entry) => {
      let sum = 0;
      let fitted = 0;
      for (const w of words) {
        const f = fitOf(entry, w);
        if (f > 0) {
          fitted += 1;
          sum += f * (weight.get(w) ?? 0);
        }
      }
      return { entry, score: words.length ? (fitted / words.length) * sum : 0 };
    })
    .filter((r) => r.score > 0)
    .sort(
      (a, b) =>
        Number(a.entry.tool.destructive) - Number(b.entry.tool.destructive) ||
        b.score - a.score ||
        a.entry.server.name.localeCompare(b.entry.server.name) ||
        a.entry.tool.name.localeCompare(b.entry.tool.name),
    );
}

const whoseAccount = (s: mcp.FoundServer) =>
  s.auth === "none"
    ? "no sign-in"
    : s.access === "personal"
      ? "each person's own (the person's here)"
      : "one shared account";

/** The tools that can be called (a destructive one is listed by a search, never in a server's count). */
const callable = (s: mcp.FoundServer) => s.tools.filter((t) => !t.destructive);

const lineOf = (s: mcp.FoundServer) => {
  const never = s.tools.length - callable(s).length;
  return {
    server: inert(s.name),
    server_id: s.id,
    whose_account: whoseAccount(s),
    status: STATE_WORDS[s.state],
    tool_count: callable(s).length,
    // Said, so a server whose tools all may overwrite (MCP's default for one that doesn't say) isn't read as empty.
    ...(never ? { never_called: never } : {}),
  };
};

/** A tool whole, as a search shows it: all it says and all it takes, or why it's never called. */
const wholeOf = (e: Entry) => ({
  server_id: e.server.id,
  server: inert(e.server.name),
  tool: e.tool.name,
  ...(e.tool.title ? { title: inert(e.tool.title) } : {}),
  ...(e.tool.description ? { about: inert(e.tool.description) } : {}),
  ...(e.tool.destructive
    ? { not_usable: NOT_USABLE }
    : { input: inert(fullSchema(e.tool.inputSchema)), ...(e.tool.asks ? { asks_first: true } : {}) }),
});

/** A tool named only, for the model to ask for by name. */
const nameOf = (e: Entry) => ({
  server_id: e.server.id,
  tool: e.tool.name,
  ...(e.tool.title ? { title: inert(e.tool.title) } : {}),
});

const NOTES = {
  none_connected: "No service is connected here. Answer from the sources, or say so.",
  names:
    "Each service's tools by name. Before calling one, get its input: mcp_find with the tool's name (or what you need) as the query. A server_id lists one service's tools with what each does.",
  list: "Before calling one, get its input: mcp_find with the tool's name as the query.",
  also: "Under also, more that matched less well: ask for one by its name for its input.",
  broad:
    "Those words are in too many tools to tell them apart: say more about what you need, or ask for one by its name for its input.",
  no_match:
    "No tool matched those words. Every service's tools are named above: ask for one by its name for its input, try other words, or give a server_id to see what each of its tools does.",
  unknown_id: "No connected service has that server_id: every one is above.",
} as const;

export interface FindInput {
  query?: string;
  server_id?: string;
}

export interface FindResult {
  value: Record<string, unknown>;
  /** What the run's steps show: how many services, and how many tools the result shows or counts. */
  summary: { query: string | null; server_id?: string; servers: number; found: number };
}

/** The servers' lines, each with its tool names (NAMES_PER_SERVER at most, then how many more). */
function withNames(servers: mcp.FoundServer[]) {
  return servers.map((s) => {
    const names = callable(s).map((t) => t.name);
    return {
      ...lineOf(s),
      ...(names.length ? { names: names.slice(0, NAMES_PER_SERVER) } : {}),
      ...(names.length > NAMES_PER_SERVER ? { more: names.length - NAMES_PER_SERVER } : {}),
    };
  });
}

/** The servers' lines, the listed ones with each tool and what it does, within LIST_CHARS. */
function withTools(servers: mcp.FoundServer[], listed: Set<string>) {
  let size = 0;
  let shown = 0;
  const lines = servers.map((s) => {
    if (!listed.has(s.id)) return lineOf(s);
    const tools = [...s.tools]
      .sort((a, b) => Number(a.destructive) - Number(b.destructive) || a.name.localeCompare(b.name))
      .map((t) => {
        const about = brief(t.description);
        const named = {
          tool: t.name,
          ...(t.title ? { title: inert(t.title) } : {}),
        };
        const full = {
          ...named,
          ...(about ? { about: inert(about) } : {}),
          ...(t.destructive ? { not_usable: NOT_USABLE } : t.asks ? { asks_first: true } : {}),
        };
        const length = JSON.stringify(full).length;
        size += length;
        shown += 1;
        return size <= LIST_CHARS ? full : named;
      });
    return { ...lineOf(s), tools };
  });
  return { lines, shown };
}

/** The pieces of a query as written (a tool's name is one), without the quotes or a full stop around one. */
const piecesOf = (query: string) =>
  query
    .split(/[\s,;]+/)
    .map((p) => p.replace(/^[`'"([{]+|[`'")\]}.:!?]+$/g, ""))
    .filter(Boolean);

/**
 * mcp_find's result: every server's line first, then what was asked for. A query's words that name a server keep the
 * search to it (`tracker` alone lists Tracker's tools); a query that is a tool's name gets that tool first, whole,
 * since the model may have seen only names; a query that matches nothing still gets every server and its tool names.
 */
export function findResult(servers: mcp.FoundServer[], input: FindInput): FindResult {
  const query = input.query?.trim() || null;
  const base = { query, ...(input.server_id ? { server_id: input.server_id } : {}), servers: servers.length };
  if (!servers.length) return { value: { servers: [], note: NOTES.none_connected }, summary: { ...base, found: 0 } };
  const count = (list: mcp.FoundServer[]) => list.reduce((n, s) => n + callable(s).length, 0);
  const names = (note: string) => ({
    value: { servers: withNames(servers), note },
    summary: { ...base, found: count(servers) },
  });

  const wanted = input.server_id?.trim().toLowerCase();
  const chosen = wanted ? servers.find((s) => s.id === wanted || s.name.toLowerCase() === wanted) : undefined;
  if (wanted && !chosen) return names(`${NOTES.unknown_id} ${NOTES.names}`);
  const listing = (listed: mcp.FoundServer[]) => {
    const { lines, shown } = withTools(servers, new Set(listed.map((s) => s.id)));
    return { value: { servers: lines, note: NOTES.list }, summary: { ...base, found: shown } };
  };
  if (!query) return chosen ? listing([chosen]) : names(NOTES.names);

  const words = [...new Set(wordsOf(query))].filter((w) => !STOP.has(w) && (w.length > 1 || /\d/.test(w)));
  // Words that name a server keep the search to it, and aren't what's searched for: "tracker comments" is Tracker's
  // comment tools, not every tool that mentions a tracker.
  const nameWords = (s: mcp.FoundServer) => new Set(wordsOf(s.name));
  const named = chosen ? [] : servers.filter((s) => words.some((w) => nameWords(s).has(w)));
  const scope = chosen ? [chosen] : named.length ? named : servers;
  const scoping = new Set(chosen || named.length ? scope.flatMap((s) => [...nameWords(s)]) : []);
  const rest = words.filter((w) => !scoping.has(w));
  const pieces = piecesOf(query).filter((p) => !wordsOf(p).every((w) => scoping.has(w)));

  const workspace = entriesOf(servers);
  const inScope = entriesOf(scope);
  // A tool asked for by its name: first and whole, since the model may have seen only names. The name as listed, or
  // else written another way (get_issue for get-issue). A one-word name (`search`) counts only when it's the whole
  // query, so "search issues" is still a search.
  const pinned: Entry[] = [];
  for (const piece of pieces) {
    const key = wordsOf(piece).join(" ");
    if (!key || (!key.includes(" ") && pieces.length > 1)) continue;
    const lower = piece.toLowerCase();
    const among = (list: Entry[]) => {
      const exact = list.filter((e) => e.tool.name.toLowerCase() === lower);
      return exact.length ? exact : list.filter((e) => wordsOf(e.tool.name).join(" ") === key);
    };
    const here = among(inScope);
    for (const hit of here.length || chosen ? here : among(workspace)) if (!pinned.includes(hit)) pinned.push(hit);
  }

  if (!rest.length && !pinned.length) return named.length || chosen ? listing(scope) : names(NOTES.names);

  let ranked = rank(inScope, rest, workspace);
  // A server named but none of its tools fitting: the words may be about another one's tools.
  if (!ranked.length && named.length) ranked = rank(workspace, rest, workspace);
  ranked = ranked.filter((r) => !pinned.includes(r.entry));
  // Nothing fits: every server's tool names, for the model to ask for one by name or try other words. Never a dead
  // end that reads as "there's no such service".
  if (!ranked.length && !pinned.length) return { ...names(NOTES.no_match), summary: { ...base, found: 0 } };

  let whole: Entry[];
  let also: Entry[];
  let note: string | null = null;
  const top = Math.max(0, ...ranked.map((r) => r.score));
  if (pinned.length) {
    whole = pinned.slice(0, MOST_MATCHES);
    also = ranked.map((r) => r.entry);
  } else if (ranked.filter((r) => r.score >= top * NEAR).length > MATCHES) {
    // The words are in many tools alike (`get`, `list`): their inputs would fill the conversation with nothing to
    // choose between them, so they're named, for the model to ask for one.
    whole = [];
    also = ranked.slice(0, MOST_MATCHES).map((r) => r.entry);
    note = NOTES.broad;
  } else {
    whole = ranked
      .filter((r) => r.score >= top * FLOOR)
      .slice(0, MATCHES)
      .map((r) => r.entry);
    also = ranked.map((r) => r.entry).filter((e) => !whole.includes(e));
  }

  // Each tool whole or not at all, within SEARCH_CHARS: a cut input is a call made wrong, and the rest of a
  // description is often how to call it well. The first is shown whatever its size; one past the bound is named.
  const shown: ReturnType<typeof wholeOf>[] = [];
  const moved: Entry[] = [];
  let size = 0;
  for (const e of whole) {
    const tool = wholeOf(e);
    const length = JSON.stringify(tool).length;
    if (shown.length && size + length > SEARCH_CHARS) {
      moved.push(e);
      continue;
    }
    shown.push(tool);
    size += length;
  }
  const more = [...moved, ...also].slice(0, note === NOTES.broad ? MOST_MATCHES : ALSO).map(nameOf);
  if (!note && more.length) note = NOTES.also;
  return {
    value: {
      servers: servers.map(lineOf),
      tools: shown,
      ...(more.length ? { also: more } : {}),
      ...(note ? { note } : {}),
    },
    summary: { ...base, found: shown.length + more.length },
  };
}

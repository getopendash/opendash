/**
 * The run vocabulary: a run's events, as the steps the Ask UI shows. Every row is one thing the agent
 * really did; there are no tool names and no tool JSON. Pure, so it's tested on its own (test/run-steps.test.ts).
 *
 *   Read context · Thinking · Looked at {n} tables · Matched "{term}" (or Looked up, when no value held it) ·
 *   Writing a query · q{n} · {title} · Checked the results · Planned {title} · Saved the draft of {title} ·
 *   Picked up where it left off · Wrapping up
 *
 * The answer and the clarify card aren't rows; the answer gate is never a step (only its results show). While a run
 * streams, its `delta` events fill in a live Thinking row and "Writing a query" rows, and the answer's
 * draft (`answerDraft`); the committed message and tool events then take their place.
 */

export interface RunEventLike {
  seq: number;
  attempt: number;
  type: string;
  data: Record<string, unknown>;
  createdAt: string;
}

export type StepStatus = "running" | "ok" | "warn" | "fail" | "info";

export interface RunStep {
  key: string;
  status: StepStatus;
  label: string;
  detail?: string;
  /** Thinking: the model's working notes (never traced, never in the answer). */
  notes?: string;
  /** q1, q2…: the query it ran, for the Sources panel. */
  alias?: string;
  queryRunId?: string;
  /** A query the semantic compiler wrote from verified definitions. */
  path?: "metric";
  /** The source it read, when it isn't the one the question started from. */
  source?: string;
  /** Lines under it: a dashboard's sections as they're written, or why a save didn't pass, in words. */
  lines?: string[];
  /** The one call it is: it opens to its input and what came back (the asker only). */
  callId?: string;
  /** A file an App's save wrote or edited (its own row, in order), or a check that found things to fix. */
  icon?: "file" | "edit" | "fix";
  /** What a check found, in words, behind the row's press. */
  found?: string[];
}

/** One thing an App's save writes, from its streamed input or its call. */
interface SaveItem {
  kind: "manifest" | "write" | "edit" | "remove";
  path?: string;
  lines?: number;
  plus?: number;
  minus?: number;
}

const fileName = (p: string) => p.replace(/^\//, "");

/** A save's items from its whole input: the manifest, each file written or removed, each file edited. */
function saveItems(input: Record<string, unknown>): SaveItem[] {
  const out: SaveItem[] = [];
  if (input.definition || (Array.isArray(input.set) && input.set.length)) out.push({ kind: "manifest" });
  for (const [path, source] of Object.entries((input.files ?? {}) as Record<string, unknown>)) {
    out.push(
      typeof source === "string" ? { kind: "write", path, lines: source.split("\n").length } : { kind: "remove", path },
    );
  }
  const edited = new Map<string, SaveItem>();
  for (const e of (Array.isArray(input.edits) ? input.edits : []) as {
    file?: unknown;
    old?: unknown;
    new?: unknown;
  }[]) {
    const file = s(e?.file);
    if (!file) continue;
    const had = edited.get(file) ?? { kind: "edit", path: file, plus: 0, minus: 0 };
    had.plus = (had.plus ?? 0) + (s(e.new) ?? "").split("\n").length;
    had.minus = (had.minus ?? 0) + (s(e.old) ?? "").split("\n").length;
    edited.set(file, had);
  }
  return [...out, ...edited.values()];
}

/** A save item as its row: what was written, done (or being written, the last one while it streams). */
function itemRow(callId: string, i: number, item: SaveItem, writing: boolean): RunStep {
  const name = item.path ? fileName(item.path) : "";
  const lines = item.lines ? `${item.lines} ${item.lines === 1 ? "line" : "lines"}` : "";
  const base = { key: `${callId}:${i}`, status: writing ? ("running" as const) : ("ok" as const) };
  if (item.kind === "manifest")
    return {
      ...base,
      icon: "file",
      label: writing ? "Writing the manifest" : "Wrote the manifest",
      detail: "its queries and filters",
    };
  if (item.kind === "remove") return { ...base, icon: "edit", label: `Removed ${name}` };
  if (item.kind === "edit")
    return {
      ...base,
      icon: "edit",
      label: writing ? `Editing ${name}` : `Edited ${name}`,
      detail: item.plus !== undefined ? `+${item.plus} −${item.minus ?? 0}` : "",
    };
  return { ...base, icon: "file", label: writing ? `Writing ${name}` : `Wrote ${name}`, detail: lines };
}

/** A save's file rows go just before its own row, replacing what it streamed. */
function placeItems(steps: RunStep[], save: RunStep, callId: string, rows: RunStep[]) {
  for (let i = steps.length - 1; i >= 0; i -= 1) if (steps[i]?.key.startsWith(`${callId}:`)) steps.splice(i, 1);
  const at = steps.indexOf(save);
  steps.splice(at < 0 ? steps.length : at, 0, ...rows);
}

const s = (v: unknown) => (typeof v === "string" ? v : undefined);

/**
 * The table a call looked at, and the other source it's in: a table's file read from the knowledge folder,
 * or catalog_describe in a run from before it.
 */
function tableLookedAt(tool: string | undefined, input: Record<string, unknown>, main: string) {
  if (tool === "catalog_describe") return { table: s(input.table) ?? "a table", other: s(input.source) };
  const file = tool === "read" ? /^\/?sources\/([^/]+)\/tables\/(.+)\.md$/.exec(s(input.path)?.trim() ?? "") : null;
  if (!file) return null;
  const [, folder = "", table = ""] = file;
  // The folder a source's name gives (the agent's folderOf: a percent sign written %25, a slash %2F).
  const own = folder.toLowerCase() === main.trim().replace(/%/g, "%25").replace(/\//g, "%2F").toLowerCase();
  return { table, other: own ? undefined : folder };
}
const n = (v: unknown) => (typeof v === "number" ? v : undefined);

/**
 * A read of the knowledge folder that isn't a table's, as its own line, so it shows which skill was used: a skill
 * read, a skill's reference, any other file; a listing; a search.
 */
function fileLine(tool: string | undefined, input: Record<string, unknown>): string | null {
  const path = s(input.path)?.trim() ?? "";
  if (tool === "read") {
    const skill = /^\/?skills\/(?:opendash\/)?([^/]+)\/(.+)$/.exec(path);
    if (skill) return skill[2] === "SKILL.md" ? `Read skill ${skill[1]}` : `Read ${skill[1]} · ${skill[2]}`;
    return path ? `Read ${path}` : "Read a file";
  }
  if (tool === "ls") return path && path !== "/" ? `Looked in ${path}` : "Looked through what OpenDash knows";
  if (tool === "grep") return s(input.pattern) ? `Searched for “${s(input.pattern)}”` : "Searched";
  return null;
}

const plural = (k: number, one: string, many = `${one}s`) => `${k.toLocaleString("en-US")} ${k === 1 ? one : many}`;

/** "98 ms", "1.2 s", "1 m 04 s". */
export function shortDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec < 10 ? sec.toFixed(1) : Math.round(sec)} s`;
  const m = Math.floor(sec / 60);
  return `${m} m ${String(Math.round(sec % 60)).padStart(2, "0")} s`;
}

/**
 * What the answer gate checked, in words: "12 numbers checked · cross-check passed". The check step says it, and the
 * Sources panel and run summary say it from the outcome once a run's events are gone.
 */
export function checkedDetail(verified: boolean, checked: { numbers: number; crossChecks: number }): string {
  if (!verified) return "some numbers couldn't be verified";
  if (checked.numbers === 0 && checked.crossChecks === 0) return "no numbers to check";
  return [
    `${plural(checked.numbers, "number")} checked`,
    checked.crossChecks
      ? `${checked.crossChecks === 1 ? "cross-check" : plural(checked.crossChecks, "cross-check")} passed`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** "Thought for 4s": how long a model call took, from the event before it. */
const thought = (ms: number) => {
  const sec = Math.max(1, Math.round(ms / 1000));
  return sec < 60 ? `Thought for ${sec}s` : `Thought for ${Math.floor(sec / 60)}m ${sec % 60}s`;
};

/** The last whole sentence of live thinking, short: what the agent is working out now. */
export function latestThought(notes: string): string | undefined {
  const text = notes.trim();
  const parts = text
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 3);
  const finished = /[.!?…]$/.test(text) ? parts : parts.slice(0, -1);
  const last = finished.at(-1) ?? parts.at(-1);
  return last ? (last.length > 90 ? `${last.slice(0, 89)}…` : last) : undefined;
}

/**
 * The events that stand: when an attempt takes over (attempt_started with discardAfterSeq), what the dead attempt
 * wrote after its last committed point never happened (resume).
 */
export function standingEvents(events: RunEventLike[]): RunEventLike[] {
  const cuts = events
    .filter((e) => e.type === "attempt_started" && e.attempt > 1 && typeof e.data.discardAfterSeq === "number")
    .map((e) => ({ attempt: e.attempt, after: e.data.discardAfterSeq as number }));
  // What an earlier attempt streamed is gone with it: only the latest attempt's drafts show.
  const latest = Math.max(1, ...events.map((e) => e.attempt));
  return events.filter(
    (e) => !cuts.some((c) => e.attempt < c.attempt && e.seq > c.after) && !(e.type === "delta" && e.attempt < latest),
  );
}

/**
 * The answer as it's being written: the text of the latest answer call's streamed input, or null. A draft
 * the gate sent back is gone; its repair streams in its place. Never shown as the answer: `draftSegments` turns
 * every number in it into a pill until the checked answer replaces it.
 */
export function answerDraft(all: RunEventLike[]): string | null {
  const drafts = new Map<string, string>();
  let current: string | null = null;
  for (const e of standingEvents(all)) {
    if (e.type === "delta") {
      const a = e.data.answer as { callId?: unknown; text?: unknown } | undefined;
      if (typeof a?.callId !== "string" || typeof a.text !== "string") continue;
      drafts.set(a.callId, (drafts.get(a.callId) ?? "") + a.text);
      current = a.callId;
    } else if (e.type === "tool_result" && e.data.tool === "answer" && e.data.accepted !== true) {
      // Sent back by the gate, or a call that failed: its draft is gone.
      if (s(e.data.callId) === current) current = null;
    }
  }
  return current ? (drafts.get(current) ?? null) : null;
}

export function runSteps(all: RunEventLike[], context: { source: string }): RunStep[] {
  const events = standingEvents(all);
  const steps: RunStep[] = [];
  const byCall = new Map<string, RunStep>();
  let tables: RunStep | null = null;
  let check: RunStep | null = null;
  let previousAt: number | null = null;
  let readContext: RunStep | null = null;
  /** The Thinking row filling in from the stream, until the call's message replaces it. */
  let live: RunStep | null = null;

  for (const e of events) {
    const at = Date.parse(e.createdAt);
    if (e.type === "delta") {
      // The model is writing: what it was given has been read.
      if (readContext?.status === "running") readContext.status = "ok";
      const thinking = s(e.data.thinking);
      if (thinking) {
        if (!live) {
          live = { key: `live-${e.seq}`, status: "running", label: "Thinking", notes: "" };
          steps.push(live);
        }
        live.notes = `${live.notes ?? ""}${thinking}`;
        // What it's on now, beside the row: the last thing it said, not the whole of its notes (a
        // build's thinking read as one wall). The notes stay one press away.
        live.detail = latestThought(live.notes);
      }
      for (const callId of Array.isArray(e.data.writing) ? e.data.writing : []) {
        if (typeof callId !== "string" || byCall.has(callId)) continue;
        const step: RunStep = { key: callId, status: "running", label: "Writing a query" };
        steps.push(step);
        byCall.set(callId, step);
      }
      for (const callId of Array.isArray(e.data.building) ? e.data.building : []) {
        if (typeof callId !== "string" || byCall.has(callId)) continue;
        const step: RunStep = { key: callId, status: "running", label: "Writing" };
        steps.push(step);
        byCall.set(callId, step);
      }
      // What it's writing, named as it arrives: its page, then each section's title.
      for (const o of Array.isArray(e.data.outline) ? e.data.outline : []) {
        const callId = s((o as { callId?: unknown }).callId);
        const step = callId ? byCall.get(callId) : undefined;
        if (step?.status !== "running") continue;
        const items = Array.isArray((o as { items?: unknown }).items) ? (o as { items: unknown[] }).items : [];
        const named = items.flatMap((x) => {
          const it = x as { id?: unknown; title?: unknown };
          return typeof it.id === "string" && typeof it.title === "string" ? [{ id: it.id, title: it.title }] : [];
        });
        const pages = named.filter((x) => x.id.startsWith("p_"));
        const sections = named.filter((x) => x.id.startsWith("s_"));
        if (pages.length === 1) step.label = `Writing ${pages[0]?.title}`;
        else if (pages.length > 1) step.label = `Writing ${pages.length} pages`;
        if (sections.length) step.lines = sections.map((x) => x.title).slice(-12);
      }
      // An App save's files as they're typed, each its own row; the one being written is the save's row for now.
      for (const o of Array.isArray(e.data.files) ? e.data.files : []) {
        const callId = s((o as { callId?: unknown }).callId);
        const step = callId ? byCall.get(callId) : undefined;
        if (!callId || step?.status !== "running") continue;
        const items = (Array.isArray((o as { items?: unknown }).items) ? (o as { items: unknown[] }).items : []).filter(
          (x): x is SaveItem => typeof (x as { kind?: unknown })?.kind === "string",
        );
        const last = items.at(-1);
        if (!last) continue;
        placeItems(
          steps,
          step,
          callId,
          items.slice(0, -1).map((it, i) => itemRow(callId, i, it, false)),
        );
        const now = itemRow(callId, items.length - 1, last, true);
        step.label = now.label;
        step.detail = now.detail ?? "";
        delete step.lines;
      }
      const answering = s((e.data.answer as { callId?: unknown } | undefined)?.callId);
      if (answering && !byCall.has(answering)) {
        const step: RunStep = { key: `answer-${answering}`, status: "running", label: "Writing the answer" };
        steps.push(step);
        byCall.set(answering, step);
      }
      // A delta isn't a step of its own: "Thought for 4s" still counts from the event before the call.
      continue;
    }
    switch (e.type) {
      case "attempt_started": {
        if (e.attempt > 1) {
          steps.push({ key: `resume-${e.seq}`, status: "info", label: "Picked up where it left off" });
        } else if (!readContext) {
          readContext = {
            key: "context",
            status: "running",
            label: "Read context",
            detail: `Catalog of ${context.source}`,
          };
          steps.push(readContext);
        }
        break;
      }
      case "assistant_message": {
        if (readContext) readContext.status = "ok";
        const reasoning = s(e.data.reasoning)?.trim();
        const thinking: RunStep | null = reasoning
          ? {
              key: `think-${e.seq}`,
              status: "ok",
              label: "Thinking",
              detail: thought(previousAt === null ? 0 : at - previousAt),
              notes: reasoning,
            }
          : null;
        // The committed message's thinking takes the live row's place, before the queries it went on to write.
        if (live) steps.splice(steps.indexOf(live), 1, ...(thinking ? [thinking] : []));
        else if (thinking) steps.push(thinking);
        live = null;
        break;
      }
      case "tool_started": {
        const callId = s(e.data.callId) ?? String(e.seq);
        const tool = s(e.data.tool);
        const input = (e.data.input ?? {}) as Record<string, unknown>;
        const looked = tableLookedAt(tool, input, context.source);
        if (!looked) tables = null;
        if (looked) {
          const table = `${looked.table}${looked.other ? ` · ${looked.other}` : ""}`;
          if (!tables) {
            tables = { key: `tables-${e.seq}`, status: "running", label: "Looked at 1 table", detail: table };
            steps.push(tables);
            (tables as RunStep & { names: string[] }).names = [table];
          } else {
            const names = (tables as RunStep & { names: string[] }).names;
            if (!names.includes(table)) names.push(table);
            tables.label = `Looked at ${plural(names.length, "table")}`;
            tables.detail =
              names.length > 3 ? `${names.slice(0, 3).join(", ")} +${names.length - 3}` : names.join(", ");
          }
          byCall.set(callId, tables);
        } else if (fileLine(tool, input)) {
          const step: RunStep = { key: callId, status: "running", label: fileLine(tool, input) as string };
          steps.push(step);
          byCall.set(callId, step);
        } else if (tool === "value_lookup") {
          const step: RunStep = {
            key: callId,
            status: "running",
            label: `Matched "${s(input.term) ?? ""}"`,
            ...(s(input.source) ? { source: s(input.source) as string } : {}),
          };
          steps.push(step);
          byCall.set(callId, step);
        } else if (tool === "sql_query" || tool === "metric_query") {
          const title = s(input.title) ?? "Query";
          // The row it streamed as "Writing a query" becomes the query.
          const written = byCall.get(callId);
          const step: RunStep = Object.assign(written ?? { key: callId }, {
            status: "running" as const,
            label: title,
            detail: "running",
            ...(tool === "metric_query" ? { path: "metric" as const } : {}),
          });
          if (!written) steps.push(step);
          byCall.set(callId, step);
        } else if (tool === "mcp_find") {
          const query = s(input.query);
          const step: RunStep = {
            key: callId,
            status: "running",
            label: "Looked for connected services",
            ...(query ? { detail: `"${query}"` } : {}),
          };
          steps.push(step);
          byCall.set(callId, step);
        } else if (tool === "mcp_call") {
          const step: RunStep = { key: callId, status: "running", label: `Using ${s(input.tool) ?? "a service"}` };
          steps.push(step);
          byCall.set(callId, step);
        } else if (tool === "dashboard_plan") {
          const step: RunStep = { key: callId, status: "running", label: "Planning the dashboard" };
          steps.push(step);
          byCall.set(callId, step);
        } else if (tool === "app_check") {
          const step: RunStep = { key: callId, status: "running", label: "Checking it at three widths" };
          steps.push(step);
          byCall.set(callId, step);
        } else if (tool === "dashboard_start") {
          const step: RunStep = { key: callId, status: "running", label: "Making the dashboard" };
          steps.push(step);
          byCall.set(callId, step);
        } else if (tool === "dashboard_save" || tool === "dashboard_page") {
          // The row it streamed as "Writing …" becomes the save being checked, its section names kept under it.
          const written = byCall.get(callId);
          const page = s((input.page as { title?: unknown } | undefined)?.title);
          const items = saveItems(input);
          const step: RunStep = Object.assign(written ?? { key: callId }, {
            status: "running" as const,
            label: page ? `Writing ${page}` : items.length ? "Building it" : "Saving it",
            detail: items.length ? "and checking it" : "",
          });
          delete step.lines;
          if (!written) steps.push(step);
          // Each file it wrote or edited, its own row in order, before the build that checks them.
          placeItems(
            steps,
            step,
            callId,
            items.map((it, i) => itemRow(callId, i, it, false)),
          );
          byCall.set(callId, step);
        } else if (tool === "dashboard_open") {
          const step: RunStep = {
            key: callId,
            status: "running",
            label: input.dashboard_id ? "Opening the dashboard" : "Looking at this conversation's dashboards",
          };
          steps.push(step);
          byCall.set(callId, step);
        } else if (tool === "definition_draft") {
          const step: RunStep = {
            key: callId,
            status: "running",
            label: `Drafting a change to ${s(input.name) ?? `the ${s(input.kind) ?? "definition"}`}`,
            detail: "testing it on the data",
          };
          steps.push(step);
          byCall.set(callId, step);
        } else if (tool === "answer") {
          // The row the answer streamed as ("Writing the answer") becomes the check of it.
          const written = byCall.get(callId);
          const at = written?.key.startsWith("answer-") ? steps.indexOf(written) : -1;
          if (at >= 0) steps.splice(at, 1);
          if (!check) {
            check = { key: "check", status: "running", label: "Checking the results" };
            steps.splice(at >= 0 ? at : steps.length, 0, check);
          } else {
            check.status = "running";
          }
          byCall.set(callId, check);
        }
        // A step that is this one call opens to it (its input, what came back); a row of several calls doesn't.
        const own = byCall.get(callId);
        if (own && own.key === callId) own.callId = callId;
        break;
      }
      case "tool_result": {
        const callId = s(e.data.callId) ?? "";
        const step = byCall.get(callId);
        const tool = s(e.data.tool);
        const failed = e.data.status === "failed" || e.data.failed === true;
        if (!step) break;
        if (step.key.startsWith("tables-")) {
          step.status = failed ? "warn" : "ok";
        } else if (tool === "read" || tool === "ls" || tool === "grep") {
          // A file read, a listing or a search: done, or what went wrong (nothing there) in a word.
          step.status = failed ? "warn" : "ok";
          if (failed) step.detail = s(e.data.message) ?? "nothing there";
        } else if (tool === "value_lookup") {
          const best = e.data.best as { column?: string; value?: string } | undefined;
          // No value contained it: the columns' most common values were read instead.
          const common = Array.isArray(e.data.common) ? e.data.common.filter((c) => typeof c === "string") : [];
          step.status = best || common.length ? "ok" : "warn";
          if (!best) step.label = step.label.replace(/^Matched /, "Looked up ");
          step.detail = best
            ? `${best.column} = '${best.value}'`
            : common.length
              ? `read the most common values of ${common.join(", ")}`
              : "no match";
        } else if (tool === "sql_query" || tool === "metric_query") {
          const alias = s(e.data.alias);
          const title = s(e.data.title) ?? step.label;
          step.label = alias ? `${alias} · ${title}` : title;
          const other = s(e.data.source);
          if (other) step.source = other;
          if (alias) step.alias = alias;
          const queryRunId = s(e.data.queryRunId);
          if (queryRunId) step.queryRunId = queryRunId;
          const ms = n(e.data.durationMs);
          if (failed) {
            step.status = "fail";
            step.detail = s(e.data.message) ?? s(e.data.error) ?? "failed";
          } else {
            const rows = n(e.data.rows) ?? 0;
            // The gateway's checks on the result (no rows, a partial period, a value not in its column).
            const warnings = Array.isArray(e.data.warnings) ? e.data.warnings.length : 0;
            step.status = e.data.truncated || warnings ? "warn" : "ok";
            step.detail = e.data.truncated
              ? `${other ? `${other} · ` : ""}first ${rows.toLocaleString("en-US")} rows`
              : [
                  other ?? null,
                  ms !== undefined ? shortDuration(ms) : null,
                  plural(rows, "row"),
                  warnings ? plural(warnings, "warning") : null,
                ]
                  .filter(Boolean)
                  .join(" · ");
          }
        } else if (tool === "mcp_find") {
          const found = n(e.data.found) ?? 0;
          const query = s(e.data.query);
          step.status = found ? "ok" : "warn";
          step.detail = [query ? `"${query}"` : null, found ? plural(found, "tool") : "none found"]
            .filter(Boolean)
            .join(" · ");
        } else if (tool === "mcp_call") {
          // Which service, which tool, whose account, how it went: never what the service sent.
          const server = s(e.data.server) ?? "a service";
          const mcpTool = s(e.data.mcp_tool) ?? "";
          const state = s(e.data.state);
          const scope = s(e.data.scope);
          if (e.data.waiting === true) {
            step.status = "warn";
            step.label = state === "consent" ? `${mcpTool} asks first` : `Needs ${server} connected`;
            step.detail = state === "consent" ? server : state === "connect" ? "not connected yet" : "sign in again";
          } else if (failed) {
            step.status = "warn";
            step.label = `Couldn't use ${server}`;
            step.detail = s(e.data.reason) ?? (state === "rate_limited" ? "it asked to slow down" : "it didn't answer");
          } else {
            step.status = "ok";
            step.label = `Read ${server}${scope === "personal" ? " as you" : ""} · ${mcpTool}`;
            step.detail =
              scope === "org" ? "the workspace's account" : scope === "none" ? "no sign-in" : "your account";
          }
        } else if (tool === "dashboard_plan") {
          step.label = failed ? "Couldn't plan the dashboard" : `Planned ${s(e.data.title) ?? "the dashboard"}`;
          step.status = failed ? "warn" : "ok";
          step.detail = failed ? (s(e.data.message) ?? "") : plural(n(e.data.pages) ?? 1, "page");
        } else if (tool === "app_check") {
          // The render check: clean, what it found to fix, or that no one had it open to measure.
          const measured = n(e.data.measured) ?? 0;
          const found = n(e.data.found) ?? 0;
          step.status = failed || found ? "warn" : measured ? "ok" : "info";
          step.label = !measured
            ? "Couldn't check it at every width"
            : found
              ? `Checked at ${plural(measured, "width")}: ${plural(found, "thing")} to fix`
              : `Checked at ${plural(measured, "width")}: clean`;
          step.detail = measured ? "" : "no one had it open";
        } else if (tool === "dashboard_start") {
          step.label = failed ? "Couldn't start it" : `Started ${s(e.data.title) ?? "it"}`;
          step.status = failed ? "warn" : "ok";
          step.detail = failed ? (s(e.data.message) ?? "") : "in Dashboards now, only you";
        } else if (tool === "dashboard_save" || tool === "dashboard_page") {
          // A draft, never a version: the person publishes it. A refusal says why, in words, under the row.
          const parts = n(e.data.parts) ?? 0;
          const page = s(e.data.page);
          // A check that found something is the agent's own work going on, said quietly, never a warning (a yellow
          // one looked alarming); what it found is one press away.
          const problems = (Array.isArray(e.data.problems) ? e.data.problems : []).filter(
            (x): x is string => typeof x === "string",
          );
          const count = n(e.data.count) ?? problems.length;
          step.label = failed
            ? count
              ? `The check found ${plural(count, "thing")} to fix`
              : "The check found something to fix"
            : page
              ? `Saved ${page}`
              : e.data.app === true
                ? "Built and checked"
                : `Saved the draft of ${s(e.data.title) ?? "it"}`;
          step.status = failed ? "info" : "ok";
          if (failed) {
            step.icon = "fix";
            // The same problem for several columns says so once, with how many (it was a list of one line, four times).
            const counted = new Map<string, number>();
            for (const line of problems) counted.set(line, (counted.get(line) ?? 0) + 1);
            if (counted.size) step.found = [...counted].map(([line, k]) => (k > 1 ? `${line} (${k} times)` : line));
          }
          delete step.lines;
          const sections = n(e.data.sections) ?? 0;
          step.detail = failed
            ? "fixing it"
            : [
                sections ? plural(sections, "section") : null,
                // An App's bundle is the App itself (its export "App"): no "custom part" to count.
                parts && e.data.app !== true ? plural(parts, "custom part") : null,
                "only you see it",
              ]
                .filter(Boolean)
                .join(" · ");
        } else if (tool === "dashboard_open") {
          step.label = s(e.data.title) ? `Read ${s(e.data.title)}` : "Looked at this conversation's dashboards";
          step.status = failed ? "warn" : "ok";
          step.detail = failed ? (s(e.data.message) ?? "") : "";
        } else if (tool === "definition_draft") {
          // A draft, never a release: what its tests found, and that it waits for a person.
          const title = s(e.data.title) ?? s(e.data.name) ?? "it";
          const checks = s(e.data.checks);
          step.label = failed ? "Couldn't draft the change" : `Drafted a change to ${title}`;
          step.status = failed || checks === "failed" ? "warn" : "ok";
          step.detail = failed
            ? (s(e.data.message) ?? "failed")
            : [
                `v${n(e.data.version) ?? 1}`,
                checks === "passed"
                  ? "tests passed"
                  : checks === "needs_review"
                    ? "a test warned"
                    : checks === "failed"
                      ? "its tests failed"
                      : "tests to come",
                "waits for release",
              ].join(" · ");
        } else if (tool === "answer") {
          if (e.data.accepted) {
            step.label = "Checked the results";
            step.status = e.data.verified ? "ok" : "warn";
            step.detail = checkedDetail(Boolean(e.data.verified), {
              numbers: n(e.data.numbers) ?? 0,
              crossChecks: n(e.data.crossChecks) ?? 0,
            });
          } else if (failed) {
            step.status = "running";
            step.detail = "writing it again";
          } else {
            const problems = Array.isArray(e.data.problems) ? e.data.problems.length : 0;
            step.status = "running";
            step.detail = `fixing ${plural(problems, "problem")}`;
          }
        }
        break;
      }
      case "note": {
        steps.push({ key: `note-${e.seq}`, status: "info", label: "Wrapping up", detail: "time to answer" });
        break;
      }
      // A follow-up the asker sent meanwhile, read before the next step.
      case "input_joined": {
        steps.push({
          key: `joined-${e.seq}`,
          status: "ok",
          label: "Read your follow-up",
          detail: s(e.data.text) ?? "",
        });
        break;
      }
      case "run_end": {
        if (readContext?.status === "running") readContext.status = "ok";
        // Anything still running when the run ended stopped with it.
        for (const step of steps) if (step.status === "running") step.status = "warn";
        break;
      }
    }
    previousAt = at;
  }
  return steps;
}

/**
 * The summary row: "Working · 12s · 2 queries" while running, "Analyzed for 24s · 4 queries · …" when done. What was
 * checked comes from the answer when the run's events are gone (they're kept for days, the answer for good).
 */
export function runSummary(
  steps: RunStep[],
  run: { status: string; startedAt: string | null; queuedAt: string; finishedAt: string | null },
  now: number,
  answer?: { verified: boolean; checked?: { numbers: number; crossChecks: number } } | null,
): string {
  const queries = steps.filter((x) => x.alias).length;
  const start = Date.parse(run.startedAt ?? run.queuedAt);
  const end = run.finishedAt ? Date.parse(run.finishedAt) : now;
  const sec = Math.round(Math.max(0, end - start) / 1000);
  const took = sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, "0")}s`;
  const check = steps.find((x) => x.key === "check" && x.status !== "running");
  const checked = check?.detail ?? (answer?.checked ? checkedDetail(answer.verified, answer.checked) : null);
  const parts = [queries ? plural(queries, "query", "queries") : null, checked].filter(Boolean);
  switch (run.status) {
    case "queued":
      return "Starting…";
    case "running":
      return ["Working", took, ...parts].join(" · ");
    case "cancelling":
      return "Stopping…";
    case "cancelled":
      return ["Stopped", took, ...parts].join(" · ");
    case "failed":
      return ["Interrupted", took, ...parts].join(" · ");
    default:
      return [`Analyzed for ${took}`, ...parts].join(" · ");
  }
}

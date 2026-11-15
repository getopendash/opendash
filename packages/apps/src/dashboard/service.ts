/**
 * A service's answer as rows: an MCP tool's result, shaped by what a dashboard's
 * service dataset declares (where its records are, and each column's path and type). Pure, deterministic and
 * versioned: no model reads or writes it, and a change to how it shapes is a new SHAPER (part of every cache key).
 */

/** How results are shaped: a change here is a new version, so no answer shaped the old way is served again. */
export const SHAPER = 1;
/** The most rows a call gives a dashboard: more is cut, and said. */
export const SERVICE_ROWS = 2000;

/** A dot path into a record: `fields.status.name`, `labels.0`. */
/**
 * A path into a service's answer: keys joined by dots, a number for a list's item (fields.status.name,
 * fields.customFields.Owner Team.value.0.value). A key may hold spaces and other marks (custom fields are named so),
 * never a dot or a control character; own keys only (at()).
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses
export const SERVICE_PATH = /^[^.\u0000-\u001f]{1,64}(\.[^.\u0000-\u001f]{1,64}){0,9}$/;

export type ServiceColumnType = "string" | "number" | "boolean" | "time" | "date";

export interface ServiceShape {
  /** Where its records are: a path to an array (empty: the answer is the array). */
  rows?: string;
  columns: { name: string; path: string; type: ServiceColumnType }[];
}

/** What a tool answered, as the MCP SDK gives it (only what shaping reads). */
export interface ToolAnswer {
  isError?: boolean;
  structuredContent?: unknown;
  content?: { type: string; text?: string }[];
}

export interface Shaped {
  rows: Record<string, string | number | boolean | null>[];
  /** Records it returned past the cap, cut. */
  cut: number;
  /** It says there's more than it returned (a total past them, a next page): totals over it aren't totals. */
  incomplete: boolean;
  /** Per column, values there that didn't read as its type (kept as empty). */
  unread: Record<string, number>;
  /** Columns whose path matched nothing in any record. */
  missing: string[];
}

/** The answer can't be read as records: an error, never shown as data. */
export class ShapeProblem extends Error {
  override name = "ShapeProblem";
}

/** The value at a dot path, or undefined. A number segment indexes an array. */
export function at(value: unknown, path: string | undefined): unknown {
  if (!path) return value;
  let here: unknown = value;
  for (const part of path.split(".")) {
    if (here === null || typeof here !== "object") return undefined;
    if (Array.isArray(here)) {
      if (!/^\d+$/.test(part)) return undefined;
      here = here[Number(part)];
    } else {
      // Own keys only: a path never reaches a prototype.
      if (!Object.hasOwn(here, part)) return undefined;
      here = (here as Record<string, unknown>)[part];
    }
  }
  return here;
}

/** The answer's JSON: its structured content, else its first text part read as JSON. */
function answerJson(answer: ToolAnswer): unknown {
  if (answer.isError) {
    const text = answer.content?.find((c) => c.type === "text")?.text ?? "";
    throw new ShapeProblem(`The service answered with an error${text ? `: ${text.slice(0, 200)}` : "."}`);
  }
  if (answer.structuredContent !== undefined && answer.structuredContent !== null) return answer.structuredContent;
  const text = answer.content?.find((c) => c.type === "text" && typeof c.text === "string")?.text;
  if (text === undefined) throw new ShapeProblem("The service's answer has no data to read.");
  try {
    return JSON.parse(text);
  } catch {
    throw new ShapeProblem("The service's answer isn't data (it isn't JSON).");
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A value as its column's type; undefined when it doesn't read as one (null and missing stay null). */
function read(value: unknown, type: ServiceColumnType): string | number | boolean | null | undefined {
  if (value === null || value === undefined) return null;
  switch (type) {
    case "string":
      return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
        ? String(value).slice(0, 2000)
        : undefined;
    case "number": {
      const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
      if (!Number.isFinite(n)) return undefined;
      // A whole number a double can't hold exactly would count as another one: not read.
      if (Number.isInteger(n) && !Number.isSafeInteger(n)) return undefined;
      return n;
    }
    case "boolean":
      return typeof value === "boolean" ? value : value === "true" ? true : value === "false" ? false : undefined;
    case "date": {
      if (typeof value !== "string") return undefined;
      const day = value.slice(0, 10);
      return realDay(day) ? day : undefined;
    }
    case "time": {
      // Epoch milliseconds, a day (taken as midnight UTC), or ISO 8601 with its offset or Z: a time with neither
      // would be read in the server's own zone, so it isn't read.
      if (typeof value === "number") {
        return Number.isFinite(value) && Math.abs(value) < 8.64e15 ? new Date(value).toISOString() : undefined;
      }
      if (typeof value !== "string") return undefined;
      if (realDay(value)) return `${value}T00:00:00.000Z`;
      const m = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/.exec(value);
      if (!m || !realDay(m[1] ?? "")) return undefined;
      const ms = Date.parse(value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
      return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
    }
  }
}

/** A real calendar day, YYYY-MM-DD (never February 30 rolled into March). */
function realDay(day: string): boolean {
  if (!ISO_DATE.test(day)) return false;
  const d = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === day;
}

/** Whether a container says it holds more than it returned. */
function saysMore(container: unknown, returned: number): boolean {
  if (!container || typeof container !== "object" || Array.isArray(container)) return false;
  const c = container as Record<string, unknown>;
  const total = c.total ?? c.totalCount ?? c.total_count;
  if (typeof total === "number" && total > returned) return true;
  if (c.isLast === false || c.has_more === true || c.hasMore === true) return true;
  for (const k of ["nextPageToken", "next_page_token", "nextCursor", "next_cursor", "next"]) {
    const v = c[k];
    if (typeof v === "string" && v.length > 0) return true;
  }
  return false;
}

/** The paths of the lists of records in an answer (lists of objects), shallow first, a few levels deep: its key names only. */
export function listsIn(value: unknown, path = "", depth = 0, out: string[] = []): string[] {
  if (out.length >= 5 || depth > 4) return out;
  if (Array.isArray(value)) {
    if (value.some((v) => v !== null && typeof v === "object" && !Array.isArray(v))) out.push(path);
    return out;
  }
  if (value === null || typeof value !== "object") return out;
  // Only keys a dataset could name (SERVICE_PATH's), at most a few of them: a service's own key names never fill the
  // message.
  for (const k of Object.keys(value).slice(0, 50)) {
    const next = path ? `${path}.${k}` : k;
    if (!SERVICE_PATH.test(next)) continue;
    listsIn((value as Record<string, unknown>)[k], next, depth + 1, out);
  }
  return out;
}

/** A tool's answer as typed rows, by its shape. Throws ShapeProblem when there are no records to read. */
export function shapeRows(answer: ToolAnswer, shape: ServiceShape): Shaped {
  const json = answerJson(answer);
  const list = at(json, shape.rows);
  if (!Array.isArray(list)) {
    // Where the answer does hold lists, so the fix is one try: "data.issues", not another guess.
    const found = listsIn(json);
    const where = found.length
      ? ` Its lists are at: ${found.map((p) => (p ? `"${p}"` : "the top (leave rows out)")).join(", ")}.`
      : "";
    throw new ShapeProblem(
      shape.rows
        ? `There's no list of records at "${shape.rows}" in the answer.${where}`
        : `The answer isn't a list of records.${where}`,
    );
  }
  const parentPath = shape.rows?.includes(".") ? shape.rows.slice(0, shape.rows.lastIndexOf(".")) : undefined;
  const incomplete =
    list.length > SERVICE_ROWS ||
    saysMore(json, list.length) ||
    (parentPath ? saysMore(at(json, parentPath), list.length) : false);
  const kept = list.slice(0, SERVICE_ROWS);
  const unread: Record<string, number> = {};
  const seen = new Set<string>();
  const rows = kept.map((record) => {
    const row: Shaped["rows"][number] = {};
    for (const c of shape.columns) {
      const raw = at(record, c.path);
      if (raw !== undefined) seen.add(c.name);
      const v = read(raw, c.type);
      if (v === undefined) {
        unread[c.name] = (unread[c.name] ?? 0) + 1;
        row[c.name] = null;
      } else row[c.name] = v;
    }
    return row;
  });
  return {
    rows,
    cut: Math.max(0, list.length - SERVICE_ROWS),
    incomplete,
    unread,
    missing: kept.length ? shape.columns.filter((c) => !seen.has(c.name)).map((c) => c.name) : [],
  };
}

/**
 * A link for a row from a template with `{column}` slots, each value URL-encoded; null when a slot's value is empty.
 * The template itself is checked when the dataset is (an https address, slots naming its columns).
 */
export function rowLink(template: string, row: Record<string, unknown>): string | null {
  let empty = false;
  const url = template.replace(/\{([a-z_][a-z0-9_]{0,62})\}/g, (_, name: string) => {
    const v = row[name];
    if (v === null || v === undefined || v === "") {
      empty = true;
      return "";
    }
    return encodeURIComponent(String(v));
  });
  return empty ? null : url;
}

/**
 * What's wrong with a row-link template, or null: an https address whose host is fixed (no slot before the path), no
 * user or password, each `{slot}` one of the dataset's columns.
 */
export function linkTemplateProblem(template: string, columns: string[]): string | null {
  const slots = [...template.matchAll(/\{([^}]*)\}/g)].map((m) => m[1] ?? "");
  const unknown = slots.find((s) => !columns.includes(s));
  if (unknown !== undefined) return `{${unknown}} isn't one of its columns.`;
  const probe = template.replace(/\{[^}]*\}/g, "x");
  let url: URL;
  try {
    url = new URL(probe);
  } catch {
    return "Give an address like https://acme.atlassian.net/browse/{key}.";
  }
  if (url.protocol !== "https:") return "A link is an https address.";
  if (url.username || url.password) return "A link carries no user or password.";
  const origin = template.slice(
    0,
    template.indexOf("/", "https://".length) === -1 ? undefined : template.indexOf("/", "https://".length),
  );
  if (origin.includes("{")) return "Its host is fixed: slots go in its path or query.";
  return null;
}

/** A row's link from a checked template, or null; its origin must stay the template's. */
export function safeRowLink(template: string, row: Record<string, unknown>): string | null {
  const link = rowLink(template, row);
  if (!link) return null;
  try {
    const want = new URL(template.replace(/\{[^}]*\}/g, "x")).origin;
    return new URL(link).origin === want ? link : null;
  } catch {
    return null;
  }
}

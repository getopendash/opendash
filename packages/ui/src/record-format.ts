// How a list of records writes its cells and its CSV: pure, so they're tested without a browser.

export interface RecordColumnLike {
  name: string;
  label: string;
  type: "string" | "number" | "boolean" | "time";
  format?: "number" | "usd" | "percent" | undefined;
}

const date = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const dateTime = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});
const plain = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** Whether a number column holds an identifier, which is written without grouping or decimals. */
export const isIdentifier = (name: string) => name === "id" || name.endsWith("_id") || name.endsWith("__id");

/** A value as a date and time, or null when it isn't one. Midnight UTC is a date. */
function parseTime(value: unknown): { date: Date; midnight: boolean } | null {
  if (value instanceof Date) return { date: value, midnight: false };
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(d.getTime())) return null;
  return { date: d, midnight: d.getUTCHours() + d.getUTCMinutes() + d.getUTCSeconds() === 0 };
}

/** A cell as the list shows it. Empty is an em dash; the raw value is what the CSV keeps. */
export function formatRecordCell(value: unknown, column: RecordColumnLike): string {
  if (value === null || value === undefined || value === "") return "—";
  if (column.type === "boolean" || typeof value === "boolean") return value === true || value === "true" ? "Yes" : "No";
  if (column.type === "time") {
    const t = parseTime(value);
    return t ? (t.midnight ? date.format(t.date) : `${dateTime.format(t.date)} UTC`) : String(value);
  }
  if (column.type === "number") {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n)) return String(value);
    if (isIdentifier(column.name)) return String(value);
    if (column.format === "usd") return dollars.format(n);
    if (column.format === "percent") return `${plain.format(n)}%`;
    return plain.format(n);
  }
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/** How a status-like value is toned: good, bad, waiting, or none. */
export function recordTone(column: string, value: unknown): "good" | "bad" | "wait" | "high" | null {
  if (!/^(status|state|priority)$/.test(column) || typeof value !== "string") return null;
  const v = value.toLowerCase();
  if (["succeeded", "paid", "active", "solved", "captured", "completed", "verified", "resolved"].includes(v))
    return "good";
  if (["failed", "canceled", "cancelled", "uncollectible", "urgent", "declined", "error"].includes(v)) return "bad";
  if (["open", "pending", "trialing", "paused", "in_progress", "past_due"].includes(v)) return "wait";
  if (v === "high") return "high";
  return null;
}

/** A spreadsheet reads a cell that starts with one of these as a formula; the CSV keeps it text. */
const FORMULA_START = /^[=+\-@\t\r]/;

const csvCell = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  let text =
    value instanceof Date ? value.toISOString() : typeof value === "object" ? JSON.stringify(value) : String(value);
  if (typeof value === "string" && FORMULA_START.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

/** The page as CSV: a header of the columns' labels, then each row's raw values. */
export function recordsCsv(columns: RecordColumnLike[], rows: unknown[][]): string {
  const lines = [
    columns.map((c) => csvCell(c.label)).join(","),
    ...rows.map((r) => columns.map((_, i) => csvCell(r[i])).join(",")),
  ];
  return `${lines.join("\r\n")}\r\n`;
}

/** "Showing 26–50 of 1,402 tickets", or "of the first 1,000 of 4,210 tickets" past the cap. */
export function recordsRange(input: {
  page: number;
  pageSize: number;
  shown: number;
  total: number;
  cap: number;
  noun: string;
}) {
  const first = input.shown === 0 ? 0 : input.page * input.pageSize + 1;
  const last = input.page * input.pageSize + input.shown;
  const n = (v: number) => v.toLocaleString("en-US");
  const of = input.total > input.cap ? `the first ${n(input.cap)} of ${n(input.total)}` : n(input.total);
  return `Showing ${n(first)}–${n(last)} of ${of} ${input.noun}`;
}

/** Whether there is a page before and after this one, within the cap. */
export function recordsPages(input: { page: number; pageSize: number; total: number; cap: number }) {
  const reachable = Math.min(input.total, input.cap);
  return { prev: input.page > 0, next: (input.page + 1) * input.pageSize < reachable };
}

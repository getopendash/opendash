/** The words around the records behind a number: its period, its groups and filters. Pure, so they're tested. */

const month = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
const day = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const dayShort = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

const DAY = 86_400_000;

/** "September 2026", "Q3 2026", "2026", "Week of Sep 7, 2026", "Sep 7, 2026", or "Sep 1 – Sep 30, 2026". */
export function periodWords(range: { from: string; to: string } | null, grain: string | null): string | null {
  if (!range) return null;
  const from = new Date(range.from);
  const last = new Date(new Date(range.to).getTime() - DAY);
  if (Number.isNaN(from.getTime()) || Number.isNaN(last.getTime())) return null;
  if (grain === "month") return month.format(from);
  if (grain === "quarter") return `Q${Math.floor(from.getUTCMonth() / 3) + 1} ${from.getUTCFullYear()}`;
  if (grain === "year") return String(from.getUTCFullYear());
  if (grain === "week") return `Week of ${day.format(from)}`;
  if (grain === "day") return day.format(from);
  // A whole calendar month or a single day without a grain (a metric's own range): say it as one.
  const wholeMonth =
    from.getUTCDate() === 1 &&
    new Date(last.getTime() + DAY).getUTCDate() === 1 &&
    last.getUTCMonth() === from.getUTCMonth();
  if (wholeMonth) return month.format(from);
  if (from.getTime() === last.getTime()) return day.format(from);
  return `${from.getUTCFullYear() === last.getUTCFullYear() ? dayShort.format(from) : day.format(from)} – ${day.format(last)}`;
}

/** "plans.name" → "Plan name"; "billing_interval" → "Billing interval". */
export function fieldWords(field: string): string {
  const spaced = field.replaceAll(".", " ").replaceAll("_", " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const OPS: Record<string, string> = {
  "=": "is",
  "!=": "is not",
  in: "is one of",
  not_in: "is none of",
  ">": "is over",
  ">=": "is at least",
  "<": "is under",
  "<=": "is at most",
  is_null: "is empty",
  is_not_null: "is set",
};

const value = (v: unknown) => (Array.isArray(v) ? v.join(", ") : v === null || v === undefined ? "empty" : String(v));

/** What narrows the records, one phrase each: "Priority is urgent", "Channel is one of chat, web". */
export function narrowingWords(view: {
  groups: { field: string; value: string | number | boolean | null }[];
  filters: { field: string; op: string; value: unknown }[];
}): string[] {
  return [
    ...view.groups.map((g) => `${fieldWords(g.field)} is ${value(g.value)}`),
    ...view.filters.map((f) =>
      f.op === "is_null" || f.op === "is_not_null"
        ? `${fieldWords(f.field)} ${OPS[f.op]}`
        : `${fieldWords(f.field)} ${OPS[f.op] ?? f.op} ${value(f.value)}`,
    ),
  ];
}

/** "Excludes test accounts" from a segment's description, else its name: "exclude_test" → "Exclude test". */
export function segmentWords(s: { name: string; description: string | null }): string {
  return s.description ?? fieldWords(s.name);
}

/** The label of a hidden field: "accounts.billing_email" → "Billing email". */
export const hiddenWords = (fields: string[]) =>
  fields.map((f) => fieldWords(f.includes(".") ? f.slice(f.lastIndexOf(".") + 1) : f));

/** How the records stand against the number that was clicked: a sentence, and whether it's a good one. */
export function reconcileWords(view: {
  kind: "count" | "distinct" | "sum" | "other";
  matches: boolean | null;
  total: number;
  value: number | null;
  expected: number | null;
  noun: string;
  valueColumn: string | null;
  format: "number" | "usd" | "percent";
}): { text: string; ok: boolean } | null {
  const n = (v: number) =>
    view.format === "usd"
      ? v.toLocaleString("en-US", { style: "currency", currency: "USD" })
      : v.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (view.expected === null) return null;
  if (view.matches === true) {
    return view.kind === "count" || view.kind === "distinct"
      ? { text: `${view.total.toLocaleString("en-US")} ${view.noun}: the number you clicked.`, ok: true }
      : { text: `Together they make ${n(view.expected)}, the number you clicked.`, ok: true };
  }
  if (view.matches === false) {
    const got = view.kind === "count" || view.kind === "distinct" ? view.total : view.value;
    return {
      text: `These give ${got === null ? "a different number" : n(got)}, not the ${n(view.expected)} you clicked: the data may have changed since that number was read.`,
      ok: false,
    };
  }
  return null;
}

/**
 * CSV for every export: a query's rows (the web and Slack alike), a dashboard's rows, a metric's records, the audit
 * log. RFC 4180, CRLF-ended, and never a formula: a spreadsheet runs a cell that starts with = + - @, a tab, a line
 * break or one of their full-width forms, so a text cell that does starts with an apostrophe. A number stays a number,
 * and so does a plain number a warehouse returned as text in a number column (a bigint, a numeric). Pure, with no Node,
 * so browser code imports it too (`@opendash/core/csv`).
 */

const FORMULA_START = /^[=+\-@\t\r\n＝＋－＠]/;
const PLAIN_NUMBER = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/** One cell: quoted when it must be, and a text cell that starts like a formula kept text. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text =
    value instanceof Date ? value.toISOString() : typeof value === "object" ? JSON.stringify(value) : String(value);
  if (typeof value === "string" && FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export interface CsvColumn {
  name: string;
  /** "number" keeps a plain number written as text a number. */
  type?: string | null;
}

/** Rows as a file's text: a header of the columns' names, then each row. */
export function csvText(columns: CsvColumn[], rows: unknown[][]): string {
  const numeric = columns.map((c) => c.type === "number");
  const cell = (value: unknown, i: number) =>
    numeric[i] && typeof value === "string" && PLAIN_NUMBER.test(value) ? value : csvCell(value);
  const lines = [
    columns.map((c) => csvCell(c.name)).join(","),
    ...rows.map((r) => columns.map((_, i) => cell(r[i], i)).join(",")),
  ];
  return lines.map((line) => `${line}\r\n`).join("");
}

/** A file name's stem: letters, digits and dashes, from a title. */
export function fileStem(title: string): string {
  const stem = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return stem || "query";
}

/**
 * A query's rows as CSV: what its query card shows (the stored result, at most 100 rows), the same file in the web and
 * in Slack. A file cut short says so in its name.
 */
export function queryCsv(card: {
  title: string | null;
  alias: string | null;
  columns: CsvColumn[];
  preview: unknown[][];
  rows: number | null;
  truncated: boolean;
}): { filename: string; text: string } {
  const total = card.rows ?? card.preview.length;
  const cut = card.truncated || total > card.preview.length;
  const stem = fileStem(card.title ?? card.alias ?? "query");
  const filename = cut ? `${stem}-first-${card.preview.length}-of-${total}-rows.csv` : `${stem}.csv`;
  return { filename, text: csvText(card.columns, card.preview) };
}

/**
 * The answer gate. Numbers reach an answer only as references to cells of
 * query results this conversation produced: ⟦q1:0:mrr⟧, or derived ⟦pct(q1:0:mrr, q1:1:mrr)⟧, which the gate
 * computes in code. The gate resolves every reference, recomputes derived values and claims, refuses numerals typed
 * outside a reference, checks that the words around a number agree with its row (the row a sentence names, a "largest"
 * that is the largest), and requires a cross-check for the headline number. Its problems go back to the model; after
 * the last repair the answer ships with what failed marked Unverified, never hidden.
 */

import type { Cell, ColumnType } from "@opendash/connectors";
import { hasFigure } from "../figures/types";
import { type ResolvedChart, resolveChart } from "./chart";
import { type Format, formatNumber, formatTime, parseFormat } from "./format";

/** One query result the conversation can cite, by its alias. */
export interface CitableResult {
  alias: string;
  queryRunId: string;
  columns: { name: string; type: ColumnType }[];
  rows: Cell[][];
  /** How it was computed: `metric` when the semantic compiler wrote it from verified definitions. */
  path?: "metric" | "raw_sql";
}

export interface Claim {
  kind: "direction" | "comparison" | "rank";
  /** Cell references, e.g. "q1:0:mrr". direction/comparison: [a, b]; rank: [target, ...others]. */
  inputs: string[];
  /** direction: up | down | flat (a against b); comparison: greater | less | equal; rank: highest | lowest. */
  assertion: string;
}

export interface CrossCheck {
  /** The headline number, and the same number computed another way (a different query). */
  headline: string;
  check: string;
  /** When the two differ on purpose (two definitions), why. The answer then has to show both. */
  differs_because?: string;
}

/** One side of a cross-check as the gate read it: the cell and its value. */
export interface CrossCheckCell {
  alias: string;
  queryRunId: string;
  row: number;
  column: string;
  value: number;
}

/**
 * A cross-check as evaluated, for the Sources panel's Checks: the headline cell, the same number computed by another
 * query, and whether they agree (exactly for counts, within 0.5% otherwise), or why they differ on purpose.
 */
export interface CheckedCrossCheck {
  headline: CrossCheckCell;
  check: CrossCheckCell;
  agrees: boolean;
  differsBecause?: string;
}

const crossCheckCell = (c: Citation, value: number): CrossCheckCell => ({
  alias: c.alias,
  queryRunId: c.queryRunId,
  row: c.row,
  column: c.column,
  value,
});

const MAX_CHARTS = 3;

export interface AnswerInput {
  status: "answered" | "cannot_answer";
  markdown: string;
  interpretation: string[];
  caveats: string[];
  claims?: Claim[];
  cross_checks?: CrossCheck[];
  /** Charts drawn from the answer's query results (chart.ts): every point is a cell. */
  charts?: unknown[];
  /** Follow-ups it can answer, as the person would ask them; questions, not claims, so not checked. */
  next?: string[];
}

export interface Citation {
  ref: string;
  alias: string;
  queryRunId: string;
  row: number;
  column: string;
  value: Cell;
}

/**
 * A rendered text as the UI shows it: plain text, and the references, each with what it shows and the cells behind it
 * (a traced number). A reference that couldn't be resolved shows as "[?]" with no cells.
 */
export type AnswerSegment =
  | { text: string }
  | {
      ref: string;
      display: string;
      kind: "number" | "text" | "time" | "unresolved";
      citations: { alias: string; queryRunId: string; row: number; column: string }[];
    };

export interface AnswerSegments {
  markdown: AnswerSegment[];
  caveats: AnswerSegment[][];
  interpretation: AnswerSegment[][];
}

export interface GateResult {
  /** No problems at all: the answer can be accepted as it is. */
  passed: boolean;
  /**
   * Every number, claim and cross-check held. A chart that can't be drawn is a problem to repair, but on the last round
   * it's dropped rather than marking a correct answer Unverified: no chart is safe, a wrong number isn't.
   */
  verified: boolean;
  problems: string[];
  /** The answer with every reference replaced by its formatted value. */
  rendered: string;
  /** The caveats and interpretation chips, rendered the same way. */
  caveats: string[];
  interpretation: string[];
  citations: Citation[];
  /** Every reference as shown: its value (derived ones computed) and its display. For the trace and graders. */
  values: { ref: string; value: number | string; display: string }[];
  /** The same texts in pieces, references apart, for rendering traced numbers. */
  segments: AnswerSegments;
  /** What was checked, for the run summary: numbers shown from references, claims and cross-checks evaluated. */
  checked: { numbers: number; claims: number; crossChecks: number };
  /** Each cross-check whose cells resolved, with both values. */
  crossChecks: CheckedCrossCheck[];
  /** The charts that resolved, each point a cell. */
  charts: ResolvedChart[];
}

export interface GateContext {
  results: CitableResult[];
  /** The user's question: numbers they typed may be echoed. */
  question: string;
  /**
   * What defines the approved glossary's terms (their names, synonyms and mapped values: "1000+", "11-50"): numbers
   * there are definitions, not measurements, so an answer may echo them. Never a term's prose or a guide's text: those
   * could state a figure no query traced.
   */
  definitions?: string;
  /**
   * The numbers in the files the asker attached: theirs. An answer may repeat one only in a sentence that
   * says it's from their file; OpenDash never verifies it.
   */
  askerNumbers?: string;
  /** Rows the model was shown per result; a reference past them cites a cell it never saw. */
  rowsShown: number;
}

const REF = /⟦([^⟦⟧]*)⟧/g;
const CELL = /^\s*q(\d+)\s*:\s*(\d+)\s*:\s*([A-Za-z_][A-Za-z0-9_]*)\s*$/;
const DERIVED = /^\s*(pct|delta|ratio|share|sum|avg)\s*\(([^()]*)\)\s*$/;
const RELATIVE_TOLERANCE = 0.005;

/** A reference body: a cell or a derived value, with an optional format. */
const BODY =
  /^\s*(?:q\d+\s*:\s*\d+\s*:\s*[A-Za-z_][A-Za-z0-9_]*|(?:pct|delta|ratio|share|sum|avg)\s*\([^()]*\))\s*(?:\|[^⟦⟧\n]*)?$/;

/**
 * Models sometimes close a reference with a lookalike (⟩, 〛, ]), or escape its closer as Markdown would
 * (⟦q9:3:sep_2026\⟧). When what's inside is a well-formed reference the intent is unambiguous, so the closer is
 * repaired; the reference is still resolved and checked like any other.
 */
export function repairClosers(text: string): string {
  const repaired = (whole: string, body: string) => (BODY.test(body) ? `⟦${body}⟧` : whole);
  return text.replace(/⟦([^⟦⟧\n]{1,300}?)\\+⟧/g, repaired).replace(/⟦([^⟦⟧⟩〛\]\n]{1,300}?)(?:⟩|〛|\]\]?)/g, repaired);
}

type Resolved =
  | { ok: true; kind: "number"; value: number; citations: Citation[]; derived?: string }
  | { ok: true; kind: "text"; value: string; citations: Citation[] }
  | { ok: true; kind: "time"; value: string; citations: Citation[] }
  | { ok: false; message: string };

const numeric = (cell: Cell): number | null => {
  if (typeof cell === "number") return Number.isFinite(cell) ? cell : null;
  if (typeof cell === "string" && /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(cell.trim())) return Number(cell);
  return null;
};

function resolveCell(raw: string, ctx: GateContext): Resolved {
  const m = CELL.exec(raw);
  if (!m)
    return { ok: false, message: `⟦${raw}⟧ isn't a reference. Write ⟦q1:0:column⟧: alias, row (from 0), column.` };
  const alias = `q${m[1]}`;
  const row = Number(m[2]);
  const columnName = m[3] as string;
  const result = ctx.results.find((r) => r.alias === alias);
  if (!result) {
    const known = ctx.results.map((r) => r.alias).join(", ");
    return {
      ok: false,
      message: `⟦${raw}⟧: there's no query ${alias} in this conversation${known ? ` (there are ${known})` : ""}.`,
    };
  }
  const index = result.columns.findIndex((c) => c.name === columnName);
  if (index < 0) {
    return {
      ok: false,
      message: `⟦${raw}⟧: ${alias} has no column ${columnName}; it has ${result.columns.map((c) => c.name).join(", ")}.`,
    };
  }
  if (row >= result.rows.length || row >= ctx.rowsShown) {
    return {
      ok: false,
      message: `⟦${raw}⟧: ${alias} has rows 0 to ${Math.min(result.rows.length, ctx.rowsShown) - 1} that you saw; there's no row ${row}.`,
    };
  }
  const cell = result.rows[row]?.[index] ?? null;
  const citation = { ref: raw.trim(), alias, queryRunId: result.queryRunId, row, column: columnName, value: cell };
  const type = result.columns[index]?.type;
  const n = numeric(cell);
  if (n !== null && type !== "text") return { ok: true, kind: "number", value: n, citations: [citation] };
  if (cell === null) return { ok: false, message: `⟦${raw}⟧ is empty (NULL) in ${alias}; say so in words instead.` };
  if (type === "date" || type === "timestamp") {
    return { ok: true, kind: "time", value: String(cell), citations: [citation] };
  }
  return { ok: true, kind: "text", value: String(cell), citations: [citation] };
}

function resolve(raw: string, ctx: GateContext): Resolved {
  const derived = DERIVED.exec(raw);
  if (!derived) return resolveCell(raw, ctx);
  const fn = derived[1] as string;
  const inputs = (derived[2] as string).split(",").map((part) => resolveCell(part, ctx));
  const failed = inputs.find((i) => !i.ok);
  if (failed) return failed;
  const values = inputs.map((i) => (i.ok && i.kind === "number" ? i.value : null));
  if (values.some((v) => v === null)) return { ok: false, message: `⟦${raw}⟧: ${fn}() needs numeric cells.` };
  const nums = values as number[];
  const citations = inputs.flatMap((i) => (i.ok ? i.citations : []));
  const two = (f: (a: number, b: number) => number | null): Resolved => {
    if (nums.length !== 2) return { ok: false, message: `⟦${raw}⟧: ${fn}() takes two cells: (current, previous).` };
    const v = f(nums[0] as number, nums[1] as number);
    return v === null
      ? { ok: false, message: `⟦${raw}⟧: ${fn}() divides by zero.` }
      : { ok: true, kind: "number", value: v, citations, derived: fn };
  };
  switch (fn) {
    case "pct":
      return two((a, b) => (b === 0 ? null : (a - b) / Math.abs(b)));
    case "delta":
      return two((a, b) => a - b);
    case "ratio":
    case "share":
      return two((a, b) => (b === 0 ? null : a / b));
    case "sum":
      return { ok: true, kind: "number", value: nums.reduce((s, v) => s + v, 0), citations, derived: fn };
    default:
      return {
        ok: true,
        kind: "number",
        value: nums.reduce((s, v) => s + v, 0) / nums.length,
        citations,
        derived: fn,
      };
  }
}

/** Defaults per derived function: pct is a signed percent, share a percent, ratio two decimals. */
function withDefaults(format: Format, derived: string | undefined): Format {
  if (derived === "pct") return { percent: true, signed: true, decimals: 1, ...format };
  if (derived === "share") return { percent: true, decimals: 1, ...format };
  if (derived === "delta") return { signed: true, ...format };
  if (derived === "ratio") return { decimals: 2, ...format };
  return format;
}

const UP = /\b(up|rose|grew|grow|growing|increased?|increasing|gained?|higher|climbed|jumped|rising)\b/i;
const DOWN =
  /\b(down|fell|fall|dropped|drop|declined?|declining|decreased?|decreasing|lower|shrank|shrunk|lost|falling)\b/i;

/** The words just before a reference, within its sentence. */
function leadIn(text: string, index: number): string {
  const before = text.slice(Math.max(0, index - 80), index);
  const cut = Math.max(before.lastIndexOf(". "), before.lastIndexOf("\n"), before.lastIndexOf("⟧"));
  return cut >= 0 ? before.slice(cut + 1) : before;
}

const MONTH_NAMES =
  "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";

/** Numerals typed outside a reference, with a little context. Exempt: dates, times, codes, list markers, code. */
export function typedNumbers(text: string, question: string, options: { durations?: boolean } = {}): string[] {
  return typedNumerals(text, question, options).map((t) => t.context);
}

/** typedNumbers with each numeral's digits, to find a cell that holds it. */
function typedNumerals(
  text: string,
  question: string,
  options: { durations?: boolean } = {},
): { digits: string; context: string; sentence: string }[] {
  const plain = (n: string) => n.replace(/,(?=\d{3}\b)/g, "");
  // Full-width and other compatibility digits read as the digits they are, in the answer and the question alike.
  const asked = question.normalize("NFKC");
  const allowed = new Set((asked.match(/\d+(?:[.,]\d+)*/g) ?? []).map(plain));
  const allowedWords = new Set((asked.match(MAGNITUDE_PHRASE) ?? []).map(phraseKey));
  let t = text
    .normalize("NFKC")
    .replace(/```[\s\S]*?```/g, " ")
    // A code span that's an amount and nothing else ("`$48,200`", "`4820`") is read like the rest; a name or SQL isn't.
    .replace(/`[^`]*`/g, (span) => (BARE_AMOUNT.test(span.slice(1, -1)) ? span.replace(/`/g, " ") : " "))
    .replace(REF, " ⟦⟧ ")
    .replace(/^\s*(?:[-*]\s+)?\d+[.)]\s/gm, " ")
    .replace(/\b\d{4}-\d{2}(?:-\d{2})?(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?)?\b/g, " ")
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " ")
    .replace(new RegExp(`\\b(?:${MONTH_NAMES})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?\\b`, "gi"), " ")
    .replace(new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTH_NAMES})\\b`, "gi"), " ")
    // A year: after a word that says so ("in 2025 orders…", "since 2024"), or unless something is counted with it
    // ("2040 paying accounts" is a count, "2026 revenue" a year). Never an amount ("$2040").
    .replace(YEAR_AFTER_DATE_WORD, " ")
    .replace(
      new RegExp(`(?<![$€£¥]\\s?[-+−]?\\s?)\\b(?:19|20)\\d{2}\\b(?!(?:\\s+[a-z-]+)?\\s+(?:${COUNTED})\\b)`, "gi"),
      " ",
    )
    // A window named by its length, not a finding: "the last 7, 30 or 90 days", "the past 12 months".
    .replace(
      /\b(?:last|past|next|previous|trailing|rolling)\s+\d+(?:\s*,\s*\d+)*(?:,?\s+(?:and|or)\s+\d+)?\s+(?:hours?|days?|weeks?|months?|quarters?|years?)\b/gi,
      " ",
    )
    // A label, not a figure: version 3, step 2, grid@4.
    .replace(/\b(?:version|step|option|batch|phase|slice|page|row)\s+\d+\b/gi, " ")
    // How many a ranking shows, not a finding: "the top 10 customers", "the bottom 5"; never "the top 10%".
    .replace(/\b(?:top|bottom)\s+\d{1,2}\b(?!\s*%|[.,]\d|\s*(?:percent|per\s*cent)\b)/gi, " ")
    .replace(/@\d+\b/g, " ")
    // Codes and names: Q3, INV-1023, v2, q1; never a currency code before an amount (USD48200).
    .replace(/\b(?!(?:USD|EUR|GBP|JPY|CHF|CAD|AUD|INR|CNY)\d)[A-Za-z]+[-_]?\d+[A-Za-z0-9_-]*\b/gi, " ")
    .replace(/\b\d+(?:st|nd|rd|th)\b/g, " ");
  if (options.durations) t = t.replace(/\b\d+\s+(?:day|week|month|quarter|year)s?\b/gi, " ");
  const found: { digits: string; context: string; sentence: string }[] = [];
  // Any script's digits, and the words for a magnitude ("forty thousand"): each is a figure typed.
  for (const m of t.matchAll(
    /[$€£]?\p{Nd}+(?:[.,]\p{Nd}+)*\s*(?:%|[kKmMbB]\b|x\b)?|\b(?:thousand|million|billion|trillion)\b/giu,
  )) {
    // A magnitude word the asker said, with the whole same quantity ("one hundred thousand"): theirs, repeated.
    const said = /^[a-z]/i.test(m[0])
      ? [...t.slice(0, (m.index ?? 0) + m[0].length).matchAll(MAGNITUDE_PHRASE)].at(-1)?.[0]
      : undefined;
    if (said && allowedWords.has(phraseKey(said))) continue;
    const digits = plain(m[0].replace(/[^\d.,]/g, ""));
    if (digits && allowed.has(digits)) continue;
    const at = m.index ?? 0;
    // The sentence it's in: from the last stop or line break before it to the next.
    const start = Math.max(t.lastIndexOf("\n", at), ...[". ", "! ", "? "].map((p) => t.lastIndexOf(p, at))) + 1;
    const ends = ["\n", ". ", "! ", "? "].map((p) => t.indexOf(p, at + m[0].length)).filter((i) => i >= 0);
    found.push({
      digits,
      context: t
        .slice(Math.max(0, at - 25), at + m[0].length + 15)
        .replace(/\s+/g, " ")
        .trim(),
      sentence: t.slice(start, ends.length ? Math.min(...ends) : t.length),
    });
  }
  return found;
}

/** A code span that's an amount and nothing else: "$48,200", "4820", "12.5%", "3.2k". */
const BARE_AMOUNT = /^\s*[-+−]?\s*[$€£¥]?\s*[-+−]?\s*\p{Nd}[\p{Nd}.,]*\s*(?:%|[kmb])?\s*$/iu;

/** Words that say a quantity before a magnitude: "a", "one hundred and twenty-five". */
const QUANTITY_WORDS =
  "a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|" +
  "eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|and|[\\d.,]+";

/** A magnitude with the whole quantity before it, as said: "forty thousand", "one hundred thousand", "2.5 million". */
const MAGNITUDE_PHRASE = new RegExp(
  `\\b(?:(?:${QUANTITY_WORDS})[\\s-]+)*(?:thousand|million|billion|trillion)\\b`,
  "gi",
);

/** A magnitude phrase as compared: lower case, one space between its words. */
const phraseKey = (w: string) =>
  w
    .toLowerCase()
    .replace(/[\s-]+/g, " ")
    .trim();

/**
 * A year after a word that says it's one: in, since, during, until, through, before, after, between, FY, a quarter, a
 * month. Not "of", "to", "by" or "from": "a total of 2040 accounts", "up to 2040", "from 2040 accounts" are counts.
 */
const YEAR_AFTER_DATE_WORD = new RegExp(
  `(?<=\\b(?:in|since|during|until|through|before|after|between|FY|year|Q[1-4]|H[12]|${MONTH_NAMES})\\.?,?\\s+)(?:19|20)\\d{2}\\b`,
  "gi",
);

/**
 * Whether a text the answer shows outside its prose (a chart's title or series name, a follow-up it offers) states a
 * figure of its own: as a dashboard's title (`hasFigure`), or a counted year, or a magnitude in words, read after the
 * same normalizing as the prose. Figures the asker wrote may be repeated ("Customers spending under $500").
 */
function statesFigure(text: string, asked: string): boolean {
  const ungrouped = (x: string) => x.normalize("NFKC").replace(/(\d),(?=\d{3}\b)/g, "$1");
  const said = ungrouped(asked);
  let t = ungrouped(text);
  // The asker's numbers, as whole numbers only ("$500" never lets "$500,500" through).
  for (const n of new Set(said.match(/\d+(?:\.\d+)?/g) ?? [])) {
    t = t.replace(new RegExp(`(?<![\\d.])${n.replace(".", "\\.")}(?![\\d]|\\.\\d)`, "g"), " ");
  }
  const phrases = new Set((said.match(MAGNITUDE_PHRASE) ?? []).map(phraseKey));
  const magnitude = (t.match(MAGNITUDE_PHRASE) ?? []).some((w) => !phrases.has(phraseKey(w)));
  return hasFigure(t) || magnitude || new RegExp(`\\b\\d{2,}\\s+(?:[a-z-]+\\s+)?(?:${COUNTED})\\b`, "i").test(t);
}

/** What a year-shaped number counts when it's a count, not a year: "2040 paying accounts". */
const COUNTED =
  "accounts?|users?|customers?|members?|people|orders?|sign-?ups?|subscriptions?|subscribers?|tickets?|invoices?|" +
  "seats?|sessions?|events?|rows?|records?|items?|deals?|leads?|licen[cs]es?|devices?|visits?|visitors?|downloads?|" +
  "installs?|transactions?|payments?|refunds?|employees?|companies|plans";

/** A sentence that says a number is the asker's own, from what they attached. */
const FROM_THEIR_FILE =
  /\b(?:your|the attached|their)\s+(?:file|notes?|document|doc|sheet|spreadsheet|attachment|csv|upload|plan|targets?)\b|\byou (?:attached|shared|uploaded)\b/i;

/**
 * A text cell that holds a formatted amount ("1,234", "12.5%", "$4.2k"): a number written as text in SQL. Cited as
 * text it would skip the number checks, so it's refused. Plain digits ("2026", "10115") can be codes and stay text.
 */
const FORMATTED_AMOUNT =
  /^\s*[-+−]?\s*(?:(?:[$€£¥]\s?)(?:\d+|\d{1,3}(?:[,.\s]\d{3})+)(?:[.,]\d+)?|(?:\d+|\d{1,3}(?:[,\s]\d{3})+)(?:[.,]\d+)?\s?(?:%|[kKmMbB]))\s*$|^\s*[-+−]?\s*(?:\d{1,3}(?:,\d{3})+|\d+)\.\d+\s*$|^\s*[-+−]?\s*\d{1,3}(?:,\d{3})+\s*$/;

/** A cited cell, as one key: q1:0:mrr. */
const cellKey = (c: { alias: string; row: number; column: string }) => `${c.alias}:${c.row}:${c.column}`;

const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A text cell that holds a typed numeral ("16" in "16+ active"): the cell to cite instead of typing it. */
function cellHolding(digits: string, ctx: GateContext): { ref: string; value: string } | null {
  const token = new RegExp(`(?<![\\d.,])${literal(digits)}(?![\\d.,])`);
  for (const r of ctx.results) {
    for (const [i, c] of r.columns.entries()) {
      for (const [row, cells] of r.rows.slice(0, ctx.rowsShown).entries()) {
        const v = cells[i];
        if (typeof v !== "string" || numeric(v) !== null || !token.test(v)) continue;
        if (c.type === "date" || c.type === "timestamp") continue;
        return { ref: `⟦${r.alias}:${row}:${c.name}⟧`, value: v };
      }
    }
  }
  return null;
}

/** A sentence of a text with its references whole: split at a sentence's end or a line break. */
const sentencesOf = (text: string) => [...text.matchAll(/[^.!?\n]+(?:[.!?]+(?=\s|$))?/g)].map((m) => m[0]);

/** Words that aren't a row's name even when a cell holds them. */
const NOT_A_NAME = new Set([
  "yes",
  "no",
  "true",
  "false",
  "other",
  "others",
  "none",
  "null",
  "unknown",
  "total",
  "all",
]);

/** Superlatives a sentence can say of a number, and the phrases that use the words otherwise. */
const MOST = /\b(largest|biggest|highest|greatest|maximum|top|most)\b/i;
const LEAST = /\b(smallest|lowest|least|fewest|minimum|bottom)\b/i;
const NOT_SUPERLATIVE =
  /\b(?:at (?:most|least)|most (?:of|recent(?:ly)?|likely|often)|least (?:of|once)|on top(?: of)?)\b/gi;

type SentenceRef = { ref: string; alias: string; row: number; column: string; kind: "number" | "text" | "time" };

/** The cell references of a sentence, resolved (derived values aren't one row's, so they're left out). */
function cellRefs(sentence: string, ctx: GateContext): SentenceRef[] {
  const refs: SentenceRef[] = [];
  for (const m of sentence.matchAll(REF)) {
    const body = (m[1] ?? "").split("|")[0] ?? "";
    if (DERIVED.test(body)) continue;
    const r = resolveCell(body, ctx);
    const c = r.ok ? r.citations[0] : undefined;
    if (r.ok && c) refs.push({ ref: body.trim(), alias: c.alias, row: c.row, column: c.column, kind: r.kind });
  }
  return refs;
}

/**
 * The rows of a result a sentence names, by column: the label cells it cites, and the label values it writes out in
 * full ("Germany", "16+ active"; a value inside a longer one it names doesn't count).
 */
function namedRows(sentence: string, refs: SentenceRef[], result: CitableResult, rowsShown: number) {
  const named = new Map<number, Set<number>>();
  const add = (col: number, row: number) => named.set(col, (named.get(col) ?? new Set()).add(row));
  for (const r of refs) {
    const col = result.columns.findIndex((c) => c.name === r.column);
    if (r.alias === result.alias && r.kind === "text" && col >= 0) add(col, r.row);
  }
  const prose = sentence.replace(REF, " ");
  const rows = result.rows.slice(0, rowsShown);
  const hits: { col: number; value: string; start: number; end: number }[] = [];
  for (const [col, c] of result.columns.entries()) {
    if (c.type === "date" || c.type === "timestamp") continue;
    const values = new Set(rows.map((cells) => cells[col]).filter((v): v is string => typeof v === "string"));
    for (const v of values) {
      const value = v.trim();
      if (value.length < 2 || value.length > 80 || !/\p{L}/u.test(value) || numeric(value) !== null) continue;
      if (NOT_A_NAME.has(value.toLowerCase())) continue;
      const m = new RegExp(`(?<![\\p{L}\\p{N}])${literal(value)}(?![\\p{L}\\p{N}])`, "iu").exec(prose);
      if (m) hits.push({ col, value, start: m.index, end: m.index + m[0].length });
    }
  }
  for (const h of hits) {
    if (hits.some((o) => o !== h && o.start <= h.start && o.end >= h.end && o.end - o.start > h.end - h.start))
      continue;
    for (const [row, cells] of rows.entries()) if (String(cells[h.col] ?? "").trim() === h.value) add(h.col, row);
  }
  return named;
}

/**
 * The words around each number against its row (the "12" that was the 6–15 band's, written as the largest band's):
 * - a sentence with one number from a result that names rows of it (a label it cites or writes out) has that number
 *   come from one of those rows (with several numbers, which goes with which isn't certain, so it isn't judged);
 * - "largest", "most", "lowest" next to a sentence's one number has to be true of its row in some number or time
 *   column of the result, unless the sentence names that row (then the superlative is about what names it). A result
 *   the model saw only part of isn't judged.
 */
function rowProblems(text: string, ctx: GateContext): string[] {
  const problems: string[] = [];
  for (const sentence of sentencesOf(text)) {
    const refs = cellRefs(sentence, ctx);
    const numbers = refs.filter((r) => r.kind === "number");
    if (!numbers.length) continue;
    for (const n of numbers) {
      const result = ctx.results.find((r) => r.alias === n.alias);
      if (!result || numbers.filter((o) => o.alias === n.alias).length !== 1) continue;
      for (const [col, rows] of namedRows(sentence, refs, result, ctx.rowsShown)) {
        const label = (row: number) => String(result.rows[row]?.[col] ?? "");
        const mine = label(n.row);
        if ([...rows].some((row) => label(row) === mine)) continue;
        const name = result.columns[col]?.name ?? "";
        const said = [...new Set([...rows].map(label))].map((v) => `"${v}"`).join(" or ");
        problems.push(
          `⟦${n.ref}⟧ is ${n.alias} row ${n.row}, whose ${name} is "${mine}", but the sentence names ${said}. Cite the row the sentence names, or name this one (⟦${n.alias}:${n.row}:${name}⟧).`,
        );
      }
    }
    if (numbers.length !== 1) continue;
    const n = numbers[0] as SentenceRef;
    const words = sentence.replace(REF, " ").replace(NOT_SUPERLATIVE, " ");
    const most = MOST.exec(words);
    const least = LEAST.exec(words);
    if (!most === !least) continue;
    const result = ctx.results.find((r) => r.alias === n.alias);
    if (!result || result.rows.length < 2 || result.rows.length >= ctx.rowsShown) continue;
    if (refs.some((r) => r.alias === n.alias && r.row === n.row && r.kind === "text")) continue;
    const pick = most ? (a: number, b: number) => a > b : (a: number, b: number) => a < b;
    const extreme = (col: number) => {
      const type = result.columns[col]?.type;
      const read = (cell: Cell) =>
        type === "date" || type === "timestamp" ? Date.parse(String(cell)) : (numeric(cell) ?? Number.NaN);
      let at = -1;
      for (const [row, cells] of result.rows.entries()) {
        const v = read(cells[col] ?? null);
        if (Number.isNaN(v)) continue;
        if (at < 0 || pick(v, read(result.rows[at]?.[col] ?? null))) at = row;
      }
      return { at, holds: at >= 0 && read(result.rows[n.row]?.[col] ?? null) === read(result.rows[at]?.[col] ?? null) };
    };
    const columns = result.columns.map((_, col) => extreme(col)).filter((e) => e.at >= 0);
    if (columns.some((e) => e.holds)) continue;
    const col = result.columns.findIndex((c) => c.name === n.column);
    const top = extreme(col);
    const word = (most ?? least)?.[1]?.toLowerCase();
    const labelCol = result.columns.find((c, i) => c.type === "text" && i !== col)?.name;
    problems.push(
      `"${word}" next to ⟦${n.ref}⟧ (${String(result.rows[n.row]?.[col])}), but that row isn't ${n.alias}'s ${most ? "largest" : "smallest"} in any column: its ${most ? "largest" : "smallest"} ${n.column} is ${String(result.rows[top.at]?.[col])}, in row ${top.at}. Cite the row you mean${labelCol ? `, and name it (⟦${n.alias}:${top.at}:${labelCol}⟧)` : ""}; if "${word}" is about something the result doesn't hold, name the row's ${labelCol ?? "label"} with a reference so the reader sees which.`,
    );
  }
  return problems;
}

function compare(a: number, b: number, integer: boolean) {
  if (integer) return a === b;
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return scale === 0 || Math.abs(a - b) / scale <= RELATIVE_TOLERANCE;
}

export function checkAnswer(raw: AnswerInput, ctx: GateContext): GateResult {
  const input: AnswerInput = {
    ...raw,
    markdown: repairClosers(raw.markdown),
    interpretation: raw.interpretation.map(repairClosers),
    caveats: raw.caveats.map(repairClosers),
  };
  const problems: string[] = [];
  const citations: Citation[] = [];
  const values: GateResult["values"] = [];
  let numericRefs = 0;
  /** Aliases of the queries numeric references cite: whether a cross-check is needed depends on their path. */
  const numericSources = new Set<string>();
  /** The cells those references read: a cross-check's headline must be one of them. */
  const numericCells = new Set<string>();

  // 1–2. Resolve every reference and render it; derived values are computed here, never by the model.
  // A % typed right after a reference that already shows as a percent would double it ("4.2%%"): it's dropped.
  // Caveats and interpretation chips are rendered and checked the same way as the answer text.
  let pieces: { offset: number; length: number; segment: AnswerSegment }[] = [];
  const cellsOf = (cs: Citation[]) =>
    cs.map((c) => ({ alias: c.alias, queryRunId: c.queryRunId, row: c.row, column: c.column }));
  const piece = (offset: number, whole: string, segment: AnswerSegment, display: string) => {
    pieces.push({ offset, length: whole.length, segment });
    return display;
  };
  const replaceRefs = (text: string) =>
    text.replace(/⟦([^⟦⟧]*)⟧(%?)/g, (whole, body: string, percent: string, offset: number) => {
      const shownAs = (display: string) => (percent && !display.endsWith("%") ? `${display}%` : display);
      const [refPart, formatPart] = body.split("|");
      const resolved = resolve(refPart ?? "", ctx);
      if (!resolved.ok) {
        problems.push(resolved.message);
        return piece(offset, whole, { ref: body.trim(), display: "[?]", kind: "unresolved", citations: [] }, "[?]");
      }
      const parsed = parseFormat(formatPart);
      if (!parsed.ok) {
        problems.push(`${whole}: ${parsed.message}`);
        return piece(offset, whole, { ref: body.trim(), display: "[?]", kind: "unresolved", citations: [] }, "[?]");
      }
      citations.push(...resolved.citations);
      const ref = (refPart ?? "").trim();
      const cells = cellsOf(resolved.citations);
      if (resolved.kind === "text") {
        if (FORMATTED_AMOUNT.test(resolved.value)) {
          problems.push(
            `${whole} is a number written as text ("${resolved.value}"): return it as a number in SQL (no to_char, concat or ::text) and format it in the reference (|currency:USD, |percent).`,
          );
        }
        values.push({ ref, value: resolved.value, display: resolved.value });
        const shown = shownAs(resolved.value);
        return piece(offset, whole, { ref, display: shown, kind: "text", citations: cells }, shown);
      }
      if (resolved.kind === "time") {
        const display = shownAs(formatTime(resolved.value, parsed.format));
        values.push({ ref, value: resolved.value, display });
        return piece(offset, whole, { ref, display, kind: "time", citations: cells }, display);
      }
      numericRefs += 1;
      for (const c of resolved.citations) {
        numericSources.add(c.alias);
        numericCells.add(cellKey(c));
      }
      let format = withDefaults(parsed.format, resolved.derived);
      let shown = resolved.value;
      // The words before a change must agree with its sign: "fell ⟦pct(…)⟧" for a rise is caught here. When they agree,
      // they already say the direction, so the change shows as a magnitude: "fell 21.2%", not "fell -21.2%".
      if (resolved.derived === "pct" || resolved.derived === "delta") {
        const words = leadIn(text, offset);
        const up = UP.test(words);
        const down = DOWN.test(words);
        if (resolved.value > 0 && down && !up) {
          problems.push(`${whole} is an increase, but the text before it says it went down.`);
        } else if (resolved.value < 0 && up && !down) {
          problems.push(`${whole} is a decrease, but the text before it says it went up.`);
        } else if (up !== down) {
          shown = Math.abs(resolved.value);
          format = { ...format, signed: false };
        }
      }
      const display = formatNumber(shown, format);
      values.push({ ref, value: resolved.value, display });
      return piece(
        offset,
        whole,
        { ref, display: shownAs(display), kind: "number", citations: cells },
        shownAs(display),
      );
    });
  /** Renders a text, and cuts it into segments: the text between references, and each reference as shown. */
  const render = (text: string): { rendered: string; segments: AnswerSegment[] } => {
    pieces = [];
    const rendered = replaceRefs(text);
    const segments: AnswerSegment[] = [];
    let at = 0;
    for (const p of pieces) {
      if (p.offset > at) segments.push({ text: text.slice(at, p.offset) });
      segments.push(p.segment);
      at = p.offset + p.length;
    }
    if (at < text.length) segments.push({ text: text.slice(at) });
    return { rendered, segments };
  };
  const answer = render(input.markdown);
  const caveatParts = input.caveats.map(render);
  const interpretationParts = input.interpretation.map(render);
  const rendered = answer.rendered;
  const renderedCaveats = caveatParts.map((c) => c.rendered);
  const renderedInterpretation = interpretationParts.map((c) => c.rendered);

  // A ⟦ that never closes isn't a reference at all; say so, rather than calling its digits typed numbers.
  const open = [...input.markdown.replace(REF, "").matchAll(/⟦[^\n]{0,40}/g)].map((m) => m[0]);
  if (open.length) {
    problems.push(
      `References start with ⟦ and end with ⟧ (not ⟩ or ]): ${open
        .slice(0, 3)
        .map((o) => `"${o}…"`)
        .join(", ")}.`,
    );
  }

  // 3. Claims, evaluated against the cells they cite.
  for (const claim of input.claims ?? []) {
    const values = claim.inputs.map((ref) => resolveCell(ref, ctx));
    const bad = values.find((v) => !v.ok);
    if (bad && !bad.ok) {
      problems.push(`Claim "${claim.kind} ${claim.assertion}": ${bad.message}`);
      continue;
    }
    const nums = values.map((v) => (v.ok && v.kind === "number" ? v.value : Number.NaN));
    if (nums.some(Number.isNaN)) {
      problems.push(`Claim "${claim.kind} ${claim.assertion}" needs numeric cells.`);
      continue;
    }
    const [a, b] = nums as [number, number];
    const holds =
      claim.kind === "direction"
        ? claim.assertion === "up"
          ? a > b
          : claim.assertion === "down"
            ? a < b
            : compare(a, b, false)
        : claim.kind === "comparison"
          ? claim.assertion === "greater"
            ? a > b
            : claim.assertion === "less"
              ? a < b
              : compare(a, b, false)
          : claim.assertion === "highest"
            ? nums.every((v) => a >= v)
            : nums.every((v) => a <= v);
    if (!holds) {
      problems.push(
        `Claim "${claim.kind} ${claim.assertion}" doesn't hold: ${claim.inputs.map((r, i) => `${r} = ${nums[i]}`).join(", ")}.`,
      );
    }
  }

  const echoable = ctx.definitions ? `${ctx.question}\n${ctx.definitions}` : ctx.question;
  // 4. No numerals outside references (the user's own numbers, dates, codes and list markers are fine).
  const typed = [
    ...typedNumerals(input.markdown, echoable),
    ...input.caveats.flatMap((c) => typedNumerals(c, echoable)),
    ...input.interpretation.flatMap((c) => typedNumerals(c, echoable, { durations: true })),
  ];
  // A number from the asker's file may be repeated where the sentence says it's theirs.
  const plainDigits = (n: string) => n.replace(/,(?=\d{3}\b)/g, "");
  const theirs = new Set((ctx.askerNumbers?.match(/\d+(?:[.,]\d+)*/g) ?? []).map(plainDigits));
  const fromFile = typed.filter((t) => theirs.has(t.digits));
  for (const t of fromFile.filter((t) => !FROM_THEIR_FILE.test(t.sentence)).slice(0, 3)) {
    problems.push(
      `"…${t.context}…" repeats a number from their file: say so in that sentence ("in your file, …"), or cite a query cell. OpenDash doesn't verify a file's numbers.`,
    );
  }
  typed.splice(0, typed.length, ...typed.filter((t) => !theirs.has(t.digits)));
  if (typed.length) {
    // A typed number that's part of a label in the results ("16+" of "16+ active") is that row's name: point at it,
    // so the model cites the row it means rather than writing around the name.
    const held = typed
      .map((t) => ({ digits: t.digits, cell: cellHolding(t.digits, ctx) }))
      .filter((h) => h.cell !== null)
      .slice(0, 2)
      .map((h) => `"${h.digits}" is part of ${h.cell?.ref} ("${h.cell?.value}")`);
    problems.push(
      `Numbers must come from query results as references, never typed: ${typed
        .slice(0, 5)
        .map((t) => `"…${t.context}…"`)
        .join(
          ", ",
        )}. Cite the cell (⟦q1:0:column⟧), compute it with pct/delta/ratio/share/sum/avg, or write it in SQL.${held.length ? ` ${held.join("; ")}: cite that cell to name the row, and take the number from the same row.` : ""}`,
    );
  }

  // 5–6. The words around each number agree with its row: the row a sentence names, a superlative that holds.
  problems.push(...rowProblems(input.markdown, ctx));

  // 7. The headline number of an answer from raw SQL needs a second, independent computation that agrees. Numbers
  // that all come from metric queries don't: the compiler wrote them from definitions an admin verified (the
  // fall-through rule: only answers that leave the metric path are always cross-checked).
  const pathOf = new Map(ctx.results.map((r) => [r.alias, r.path ?? "raw_sql"]));
  const unmodelled = [...numericSources].some((alias) => pathOf.get(alias) !== "metric");
  const crossChecks: CheckedCrossCheck[] = [];
  if (numericRefs > 0 && unmodelled) {
    const checks = input.cross_checks ?? [];
    if (!checks.length) {
      problems.push(
        "Add a cross-check: compute the headline number a second, independent way (another query: a different grain, the sum of segments, another table) and list it in cross_checks.",
      );
    } else if (
      !checks.some((c) => {
        const a = resolveCell(c.headline, ctx);
        return a.ok && a.citations.some((x) => numericCells.has(cellKey(x)));
      })
    ) {
      problems.push(
        "Cross-check the answer's own headline: a cross_checks headline must be a cell the answer cites as a number (⟦q1:0:mrr⟧ in the text → headline q1:0:mrr).",
      );
    }
    for (const c of checks) {
      const a = resolveCell(c.headline, ctx);
      const b = resolveCell(c.check, ctx);
      if (!a.ok || !b.ok) {
        problems.push(`Cross-check: ${!a.ok ? a.message : !b.ok ? b.message : ""}`);
        continue;
      }
      if (a.kind !== "number" || b.kind !== "number") {
        problems.push("Cross-check: both sides need numeric cells.");
        continue;
      }
      if (a.citations[0]?.alias === b.citations[0]?.alias) {
        problems.push(`Cross-check: ${c.headline} and ${c.check} come from the same query; use a separate query.`);
        continue;
      }
      const integers = Number.isInteger(a.value) && Number.isInteger(b.value);
      const agrees = compare(a.value, b.value, integers);
      const because = c.differs_because?.trim();
      const [headline, other] = [a.citations[0], b.citations[0]];
      if (headline && other) {
        crossChecks.push({
          headline: crossCheckCell(headline, a.value),
          check: crossCheckCell(other, b.value),
          agrees,
          ...(because ? { differsBecause: because } : {}),
        });
      }
      if (!agrees && !because) {
        problems.push(
          `Cross-check disagrees: ${c.headline} = ${a.value}, ${c.check} = ${b.value} (tolerance ${integers ? "exact for counts" : "0.5%"}). Find out why: a bug (fix the query) or two definitions (set differs_because and show both in the answer).`,
        );
      }
    }
  }

  if (!input.markdown.trim()) problems.push("The answer is empty.");
  // Every text the answer shows is held to the same rule: a chart's title and series names, and the follow-ups it
  // offers, state no figure of their own (as a dashboard's title doesn't).
  const shown = [
    ...(input.charts ?? []).flatMap((c) => {
      const spec = (c ?? {}) as { title?: unknown; labels?: unknown };
      return [spec.title, ...(Array.isArray(spec.labels) ? spec.labels : [])];
    }),
    ...(input.next ?? []),
  ].filter((t): t is string => typeof t === "string");
  for (const t of shown.filter((t) => statesFigure(t, echoable)).slice(0, 3)) {
    problems.push(
      `"${t.slice(0, 80)}" states a figure outside a reference: say what it shows, and let a reference or the chart show the number.`,
    );
  }
  // 8. Charts: each point read from a cell of the result it names, or a problem to fix.
  const verified = problems.length === 0;
  const charts: ResolvedChart[] = [];
  const specs = input.charts ?? [];
  if (specs.length > MAX_CHARTS) problems.push(`At most ${MAX_CHARTS} charts per answer.`);
  for (const spec of specs.slice(0, MAX_CHARTS)) {
    const r = resolveChart(spec, ctx.results);
    if (r.ok) charts.push(r.chart);
    else problems.push(r.problem);
  }

  return {
    passed: problems.length === 0,
    verified,
    charts,
    problems,
    rendered,
    caveats: renderedCaveats,
    interpretation: renderedInterpretation,
    citations,
    values,
    segments: {
      markdown: answer.segments,
      caveats: caveatParts.map((c) => c.segments),
      interpretation: interpretationParts.map((c) => c.segments),
    },
    checked: {
      numbers: numericRefs,
      claims: input.claims?.length ?? 0,
      crossChecks: input.cross_checks?.length ?? 0,
    },
    crossChecks,
  };
}

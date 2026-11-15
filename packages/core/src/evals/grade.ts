/**
 * Grading an eval case: the numbers the answer must cite come
 * from the case's reference, recomputed at eval time, and the answer passes when it's an answer, its gate passed, and
 * it cites every one of them. The product's own grader, numbers only: the benchmark's (`@opendash/evals`) also grades
 * texts, refusals and clarifications, and the product never imports it.
 */
import type { Cell } from "@opendash/connectors";
import type { CompiledColumn } from "../semantic/compile";

export interface ExpectedNumber {
  /** The reference's column (mrr, mrr_previous) and, for a series, its period: what the reason names. */
  label: string;
  value: number;
  display: string;
}

/** The reference's measure cells when there are at most six; else those of its last row (the latest period). */
export const EXPECTED_MAX = 6;

/**
 * The numbers the answer must cite, from the reference's rows. Null cells aren't expected (nothing to cite); a
 * reference with none leaves the case ungradable.
 */
export function expectedNumbers(
  roles: CompiledColumn[],
  rows: Cell[][],
  display: (value: number, column: CompiledColumn) => string,
): ExpectedNumber[] {
  const measures = roles.map((c, i) => ({ c, i })).filter(({ c }) => c.role === "measure");
  const period = roles.findIndex((r) => r.role === "time");
  // In a series, each number is named with its period.
  const series = period >= 0 && rows.length > 1;
  const cells = (rs: Cell[][]) =>
    rs.flatMap((row) =>
      measures.flatMap(({ c, i }) => {
        const raw = row[i];
        const value = raw === null || raw === undefined || raw === "" ? null : Number(raw);
        if (value === null || !Number.isFinite(value)) return [];
        const when = series ? ` (${String(row[period]).slice(0, 10)})` : "";
        return [{ label: `${c.name}${when}`, value, display: display(value, c) }];
      }),
    );
  const all = cells(rows);
  return all.length <= EXPECTED_MAX ? all : cells(rows.slice(-1));
}

/** Counts (whole numbers) match exactly; anything else within 0.5%, cross-check tolerance. */
export function matches(cited: number, expected: number): boolean {
  if (Number.isInteger(expected)) return cited === expected;
  return Math.abs(cited - expected) / Math.max(1e-9, Math.abs(expected)) <= 0.005;
}

/** What grading needs of a run's outcome (the ledger's answer outcome). */
export interface AnswerOutcome {
  kind: string;
  status?: string;
  verified?: boolean;
  rendered?: string;
  path?: string;
  values?: { ref: string; value: number | string; display: string }[];
}

export interface Graded {
  verdict: "pass" | "fail";
  reason: string;
  /** The gate didn't pass: a number in the answer isn't traced to a query (DashBench's must-never). */
  untraced: boolean;
  cited: { value: number; display: string }[];
}

const list = (xs: string[]) =>
  xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;

export function gradeAnswer(expected: ExpectedNumber[], outcome: AnswerOutcome | null): Graded {
  const cited = (outcome?.values ?? []).flatMap((v) =>
    typeof v.value === "number" ? [{ value: v.value, display: v.display }] : [],
  );
  const fail = (reason: string, untraced = false): Graded => ({ verdict: "fail", reason, untraced, cited });
  if (!outcome) return fail("The analyst didn't finish.");
  if (outcome.kind === "clarify") return fail("It asked a question instead of answering.");
  if (outcome.kind !== "answer") return fail(`It didn't answer (${outcome.kind}).`);
  if (outcome.status !== "answered") return fail("It said it couldn't answer.");
  if (outcome.verified === false) return fail("A number in its answer isn't traced to a query.", true);
  const missing = expected.filter((e) => !cited.some((c) => matches(c.value, e.value)));
  if (missing.length) {
    return fail(
      `Expected ${list(missing.map((m) => m.display))}; the answer cited ${list(cited.map((c) => c.display)) || "no numbers"}.`,
    );
  }
  return { verdict: "pass", reason: `Cited ${list(expected.map((e) => e.display))}.`, untraced: false, cited };
}

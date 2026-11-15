// The golden set's grader on its own, and every question's expected answer computed on the seeded demo.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GOLDEN, grade } from "../src";
import { type SeededDatabase, seededDatabase } from "../src/testing";

const answer = (values: (number | string)[], extra: Record<string, unknown> = {}) => ({
  kind: "answer",
  status: "answered",
  verified: true,
  rendered: values.join(" "),
  interpretation: [],
  values: values.map((value, i) => ({ ref: `q1:${i}:x`, value, display: String(value) })),
  ...extra,
});

describe("grader", () => {
  const numbers = {
    kind: "numbers" as const,
    groups: [
      [
        { label: "MRR", value: 412621.44 },
        { label: "change", value: 0.0421, absolute: 0.002 },
      ],
    ],
  };

  it("passes when every expected number is cited, within tolerance", () => {
    expect(grade(numbers, answer([412600, 0.042])).pass).toBe(true);
    expect(grade(numbers, answer([412600])).pass).toBe(false);
    expect(grade(numbers, answer([41260000, 0.042])).reason).toMatch(/expected MRR/);
  });

  it("counts are exact", () => {
    const counts = { kind: "numbers" as const, groups: [[{ label: "accounts", value: 1203 }]] };
    expect(grade(counts, answer([1203])).pass).toBe(true);
    expect(grade(counts, answer([1234])).pass).toBe(false);
  });

  it("an unverified answer never passes, and counts as untraced", () => {
    const g = grade(numbers, answer([412600, 0.042], { verified: false }));
    expect(g).toMatchObject({ pass: false, untraced: true });
  });

  it("accepts a forecast declined or disclosed as an estimate, never one stated as fact", () => {
    const e = { kind: "estimate_or_decline" as const };
    expect(grade(e, answer([531400], { status: "cannot_answer" })).pass).toBe(true);
    expect(grade(e, answer([531400], { caveats: ["This is an extrapolation of past trend."] })).pass).toBe(true);
    expect(grade(e, answer([531400], { rendered: "MRR will be $531.4k at the end of March." })).pass).toBe(false);
  });

  it("matches names as words, not inside other words", () => {
    const country = { kind: "texts" as const, texts: [["US", "United States"]] };
    expect(grade(country, answer(["Most customers are in Germany."])).pass).toBe(false);
    expect(grade(country, answer(["US"])).pass).toBe(true);
    expect(grade(country, answer(["The United States leads."])).pass).toBe(true);
  });

  it("grades refusals, clarifications and personal data", () => {
    expect(grade({ kind: "cannot_answer" }, answer([], { status: "cannot_answer" })).pass).toBe(true);
    expect(grade({ kind: "cannot_answer" }, answer([5])).pass).toBe(false);
    expect(grade({ kind: "clarify_or_default" }, { kind: "clarify" }).pass).toBe(true);
    expect(grade({ kind: "clarify_or_default" }, answer([1], { interpretation: ["MRR"] })).pass).toBe(true);
    expect(grade({ kind: "no_personal_data" }, answer(["maya@acme.com"])).pass).toBe(false);
    expect(grade({ kind: "no_personal_data" }, answer([], { status: "cannot_answer" })).pass).toBe(true);
  });
});

describe("expected answers on the demo", () => {
  let db: SeededDatabase;
  beforeAll(async () => {
    db = await seededDatabase();
  }, 180_000);
  afterAll(async () => {
    await db?.drop();
  });

  it("every question computes its expectation, and the calibrated ones match their figures", async () => {
    const expectations = Object.fromEntries(
      await Promise.all(GOLDEN.map(async (g) => [g.id, await g.expect(db.query)] as const)),
    );
    expect(Object.keys(expectations)).toHaveLength(GOLDEN.length);
    expect(GOLDEN.length).toBeGreaterThanOrEqual(20);
    const mrr = expectations.mrr_change;
    if (mrr?.kind !== "numbers") throw new Error("mrr_change should expect numbers");
    expect(Math.round((mrr.groups[0]?.[0]?.value ?? 0) / 100) * 100).toBe(412_600);
    expect(mrr.groups[0]?.[1]?.value).toBeCloseTo(0.042, 3);
    const churn = expectations.churn_total;
    if (churn?.kind !== "numbers") throw new Error("churn_total should expect numbers");
    expect(Math.round(churn.groups[0]?.[0]?.value ?? 0)).toBe(9_800);
    for (const [id, e] of Object.entries(expectations)) {
      if (e.kind === "numbers") for (const n of e.groups.flat()) expect(Number.isFinite(n.value), id).toBe(true);
    }
  });
});

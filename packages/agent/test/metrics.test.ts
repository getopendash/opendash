// Which verified metrics a question names: by name, label or synonym, as whole words, plural or singular, so a
// paraphrase still finds the verified queries over them.
import type { LoadedModel } from "@opendash/core";
import { describe, expect, it } from "vitest";
import { mentionedMetrics } from "../src/instructions/metrics";

const model = {
  model: {
    metrics: new Map(
      [
        { name: "mrr", label: "Monthly recurring revenue", synonyms: ["recurring revenue", "MRR"] },
        { name: "churned_mrr", label: "Churned MRR", synonyms: ["lost MRR", "churn"] },
        { name: "paying_customers", label: "Paying customers", synonyms: ["paying accounts"] },
      ].map((m) => [m.name, m]),
    ),
  },
} as unknown as LoadedModel;

describe("mentionedMetrics", () => {
  it("finds names, labels and synonyms as whole words", () => {
    expect(mentionedMetrics("how much did our monthly recurring revenue move in september?", model)).toEqual(["mrr"]);
    expect(mentionedMetrics("september churn in MRR terms, per plan please", model)).toEqual(["mrr", "churned_mrr"]);
    expect(mentionedMetrics("Paying customer count at close of last month?", model)).toEqual(["paying_customers"]);
    expect(mentionedMetrics("paying customers at the end of the month", model)).toEqual(["paying_customers"]);
    // Not inside other words.
    expect(mentionedMetrics("the summrry of churned_mrrx", model)).toEqual([]);
    expect(mentionedMetrics("anything", null)).toEqual([]);
  });
});

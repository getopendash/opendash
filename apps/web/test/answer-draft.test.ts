// The answer's draft: the only path from a streaming draft to the screen. No figure shows before the
// gate checked it: every reference, a reference still being written, and any number typed outside one is a pill.
import { describe, expect, it } from "vitest";
import { type DraftSegment, draftSegments } from "../lib/answer-draft";

const shown = (draft: string) =>
  draftSegments(draft).map((p: DraftSegment[]) => p.map((s) => (s.kind === "pill" ? "▢" : s.text)).join(""));

describe("an answer's draft", () => {
  it("shows every reference as a pill", () => {
    expect(shown("MRR was ⟦q1:0:mrr|currency:USD⟧, up ⟦pct(q1:0:mrr, q1:1:mrr)⟧.")).toEqual(["MRR was ▢, up ▢."]);
  });

  it("hides a reference still being written, and whatever came after its ⟦", () => {
    expect(shown("MRR was ⟦q1:0:m")).toEqual(["MRR was ▢"]);
    expect(shown("⟦q1")).toEqual(["▢"]);
  });

  it("never shows a number typed outside a reference, in any form", () => {
    expect(shown("It fell 12.5% to $412,600 (−3k), about 1.2M in 2026.")).toEqual([
      "It fell ▢ to ▢ (▢), about ▢ in ▢.",
    ]);
    // Digits in a word too: the gate checks them, so the draft never shows one it might refuse.
    expect(shown("Bookings grew 3x to €5bn, up 12pp; churn 5bps; $1.2bn; USD1,234; 40hrs")).toEqual([
      "Bookings grew ▢x to ▢, up ▢pp; churn ▢bps; ▢; USD▢; ▢hrs",
    ]);
    expect(shown("Q3 plans")).toEqual(["Q▢ plans"]);
  });

  it("keeps paragraphs and drops markdown's marks", () => {
    expect(shown("## Churn\n\n**Starter** fell most.\n\n- Growth was flat")).toEqual([
      "Churn",
      "Starter fell most.",
      "• Growth was flat",
    ]);
    expect(shown("")).toEqual([]);
  });
});

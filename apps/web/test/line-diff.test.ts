// A definition's draft against its released YAML: what it added and removed, in order, with a few
// lines around each change and the rest folded.
import { describe, expect, it } from "vitest";
import { lineDiff } from "../lib/line-diff";

const released = ["name: mrr", "label: MRR", "segments:", "  - test_accounts", "format: usd", ""].join("\n");

describe("lineDiff", () => {
  it("names an added line among the ones that stayed", () => {
    const draft = released.replace("  - test_accounts", "  - test_accounts\n  - refunded_items");
    expect(lineDiff(released, draft)).toEqual([
      { kind: "same", text: "name: mrr" },
      { kind: "same", text: "label: MRR" },
      { kind: "same", text: "segments:" },
      { kind: "same", text: "  - test_accounts" },
      { kind: "added", text: "  - refunded_items" },
      { kind: "same", text: "format: usd" },
    ]);
  });

  it("names a changed line as removed then added, marking the words that changed", () => {
    const draft = released.replace("label: MRR", "label: Monthly recurring revenue");
    const changed = lineDiff(released, draft).filter((l) => l.kind !== "same");
    expect(changed).toEqual([
      { kind: "removed", text: "label: MRR", mark: [7, 10] },
      { kind: "added", text: "label: Monthly recurring revenue", mark: [7, 32] },
    ]);
  });

  it("marks only what a line gained when nothing was taken out of it", () => {
    const before = "  Leaves out test accounts and paused subscriptions.";
    const after = "  Leaves out refunds, test accounts and paused subscriptions.";
    const [removed, added] = lineDiff(before, after);
    expect(removed).toEqual({ kind: "removed", text: before });
    expect(added).toMatchObject({ kind: "added", mark: [13, 22] });
    expect(after.slice(13, 22)).toBe("refunds, ");
  });

  it("folds the lines far from any change", () => {
    const long = Array.from({ length: 20 }, (_, k) => `line ${k}`).join("\n");
    const draft = long.replace("line 10", "line ten");
    const out = lineDiff(long, draft, 2);
    expect(out[0]).toEqual({ kind: "gap", lines: 8 });
    expect(out.at(-1)).toEqual({ kind: "gap", lines: 7 });
    expect(out.filter((l) => l.kind === "same")).toHaveLength(4);
  });

  it("compares only the middle a change left between the same start and end, and caps its size", () => {
    const sql = Array.from({ length: 6000 }, (_, k) => `  select ${k} as c${k}`).join("\n");
    const draft = sql.replace("select 3000 as c3000", "select 3000 as total");
    const out = lineDiff(sql, draft, 1);
    expect(out.filter((l) => l.kind === "removed" || l.kind === "added")).toHaveLength(2);
    // A rewrite too big to compare line by line is all removed, then all added.
    const rewrite = lineDiff(
      Array.from({ length: 2500 }, (_, k) => `a${k}`).join("\n"),
      Array.from({ length: 2500 }, (_, k) => `b${k}`).join("\n"),
      0,
    );
    expect(rewrite.filter((l) => l.kind === "removed")).toHaveLength(2500);
    expect(rewrite.filter((l) => l.kind === "added")).toHaveLength(2500);
  });

  it("is nothing when nothing changed", () => {
    expect(lineDiff(released, released)).toEqual([]);
  });
});

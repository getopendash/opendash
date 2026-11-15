// What a filter's popover lists: an applied or ticked value stays listed while the popover is open, even when it
// isn't among the values offered, so it can be ticked again after it's unticked.
import { describe, expect, it } from "vitest";
import { listedValues } from "../src/components/filter-chip";

describe("a filter's listed values", () => {
  it("keeps an applied value that's no longer offered, even once it's unticked", () => {
    const offered = ["Growth", "Starter"];
    expect(listedValues(offered, ["Legacy"], ["Legacy"])).toEqual(["Growth", "Legacy", "Starter"]);
    expect(listedValues(offered, ["Legacy"], [])).toEqual(["Growth", "Legacy", "Starter"]);
  });

  it("keeps a value a search found and ticked, after the search is cleared", () => {
    expect(listedValues(["Acme"], [], ["Zeta Corp"])).toEqual(["Acme", "Zeta Corp"]);
  });

  it("lists a column's values in the order given, the applied ones first, without moving one when it's ticked", () => {
    const common = ["Kitepath", "Atlasbridge", "Nordwind"];
    expect(listedValues(common, ["Nordwind"], ["Nordwind"], true)).toEqual(["Nordwind", "Kitepath", "Atlasbridge"]);
    expect(listedValues(common, ["Nordwind"], ["Nordwind", "Atlasbridge"], true)).toEqual([
      "Nordwind",
      "Kitepath",
      "Atlasbridge",
    ]);
    expect(listedValues(common, ["Old Co"], [], true)).toEqual(["Old Co", "Kitepath", "Atlasbridge", "Nordwind"]);
  });
});

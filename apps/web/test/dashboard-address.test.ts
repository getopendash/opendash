// An App's shareable state in the page's address: what the frame shows (its filters, the record) goes into the
// address and comes back from it on a reload or a shared link, read only as the definition's own filters take it.
import { describe, expect, it } from "vitest";
import { searchFromState, stateFromSearch } from "@/components/dashboards/dashboard-host";

const definition = {
  filters: {
    f_period: { kind: "period", default: "last_12_months" },
    f_plan: { kind: "select", default: ["Growth"] },
  },
};

describe("a dashboard's address", () => {
  it("round-trips its filters, a value with a comma in it too", () => {
    const state = { filters: { f_period: "last_month", f_plan: ["Scale, annual", "Growth"] } };
    const search = searchFromState("", state, definition);
    expect(search).toBe("?f_period=last_month&f_plan=Scale%2C+annual&f_plan=Growth");
    expect(stateFromSearch(search, definition)).toEqual(state);
  });

  it("writes only what differs from the defaults, and every value (an empty choice) differs from a default one", () => {
    expect(searchFromState("", { filters: { f_period: "last_12_months", f_plan: ["Growth"] } }, definition)).toBe("");
    const all = searchFromState("", { filters: { f_plan: [] } }, definition);
    expect(all).toBe("?f_plan=");
    expect(stateFromSearch(all, definition)).toEqual({ filters: { f_plan: [] } });
  });

  it("keeps the page's own parameters, and reads only the definition's own filters", () => {
    expect(searchFromState("?draft=1&f_plan=Scale", { filters: { f_period: "this_year" } }, definition)).toBe(
      "?draft=1&f_period=this_year",
    );
    expect(stateFromSearch("?f_plan=Scale&f_region=EU&toString=x&__proto__=y", definition)).toEqual({
      filters: { f_plan: ["Scale"] },
    });
  });
});

describe("a record in the address", () => {
  it("round-trips the record shown, and takes no key too long to be one", () => {
    const state = { filters: {}, record: 42 };
    const search = searchFromState("", state, definition);
    expect(search).toBe("?r=42");
    // Back as text: the server types it by its column.
    expect(stateFromSearch(search, definition)).toEqual({ filters: {}, record: "42" });
    expect(stateFromSearch(`?r=${"x".repeat(201)}`, definition)).toEqual({ filters: {} });
  });
});

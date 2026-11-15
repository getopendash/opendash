// The choose screen's words: why a table is where it is, and the table the picked ones join that isn't picked.
import type { LearningTable } from "@opendash/core";
import { describe, expect, it } from "vitest";
import { alsoLearn, joinedByText, learningWhy } from "../lib/source-learning";

const table = (name: string, extra: Partial<LearningTable> = {}): LearningTable => ({
  name,
  kind: "table",
  rows: null,
  queries: 0,
  joinsTo: [],
  learned: false,
  ticked: false,
  new: false,
  ...extra,
});

describe("choosing what OpenDash learns", () => {
  it("says why a table ranks where it does, as the choose screen does", () => {
    expect(learningWhy(table("app.v_opportunities", { kind: "view", rows: 18204, queries: 412 }), true)).toBe(
      "View · 18,204 rows · read by 412 of your team's queries",
    );
    expect(
      learningWhy(table("app.orders", { rows: 220410, queries: 214, joinsTo: ["app.customers", "app.plans"] })),
    ).toBe("220,410 rows · read by 214 · joins customers, plans");
    expect(learningWhy(table("app.audit_log", { rows: 22_100_000 }))).toBe("22,100,000 rows · not queried");
  });

  it("names the unpicked table the picked ones join most, and which of them join it", () => {
    const tables = [
      table("app.shipments", { joinsTo: ["app.orders"] }),
      table("app.order_items", { joinsTo: ["app.orders", "app.customers"] }),
      table("app.customers"),
      table("app.orders"),
    ];
    const picked = new Set(["app.shipments", "app.order_items", "app.customers"]);
    expect(alsoLearn(tables, picked)).toEqual({
      table: "app.orders",
      joinedBy: ["app.shipments", "app.order_items"],
    });
    expect(joinedByText(["app.shipments", "app.order_items"])).toBe("shipments and order_items");
    expect(joinedByText(["app.a", "app.b", "app.c", "app.d"])).toBe("a, b and 2 more");
    // Everything they join is picked: nothing to suggest.
    expect(alsoLearn(tables, new Set([...picked, "app.orders"]))).toBeNull();
  });
});

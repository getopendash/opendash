// How a table is described to the analyst and on the Catalog page: one wording for both.
import { describe, expect, it } from "vitest";
import { engineHint, joinLabel, keysLine, modelledLine, modelsByTable, readsLine, shapeHints } from "../src";

describe("a table card", () => {
  it("says what an engine means for reading it", () => {
    expect(engineHint({ engine: "ReplacingMergeTree", engineColumns: ["version"] })).toMatch(
      /^ReplacingMergeTree by version: .*a key can repeat until then\. Read it with FINAL/,
    );
    expect(engineHint({ engine: "SharedReplacingMergeTree", engineColumns: ["version", "is_deleted"] })).toMatch(
      /rows marked is_deleted stay until then/,
    );
    expect(engineHint({ engine: "ReplicatedCollapsingMergeTree", engineColumns: ["sign"] })).toMatch(
      /^ReplicatedCollapsingMergeTree by sign: Rows cancel out.*Count with sum\(sign\), add a measure up as sum\(x \* sign\)/,
    );
    expect(engineHint({ engine: "SummingMergeTree" })).toMatch(/Always aggregate it/);
    expect(engineHint({ engine: "AggregatingMergeTree" })).toMatch(/-Merge functions/);
    // A table that reads as stored says nothing.
    expect(engineHint({ engine: "MergeTree" })).toBeNull();
    expect(engineHint(null)).toBeNull();
  });

  it("names its keys: ClickHouse's sorting and partition keys, or a unique key", () => {
    expect(
      keysLine({ sortingKey: "org_id, created_at", primaryKey: "org_id", partitionKey: "toYYYYMM(created_at)" }, []),
    ).toBe("sorted by org_id, created_at · primary key org_id · partitioned by toYYYYMM(created_at)");
    // The primary key ClickHouse defaults to the sorting key isn't said twice.
    expect(keysLine({ sortingKey: "id", primaryKey: "id" }, [])).toBe("sorted by id");
    expect(keysLine(null, ["rate_date", "currency"])).toBe("unique key rate_date, currency");
    expect(keysLine(null, [])).toBeNull();
  });

  it("says what a view reads, and how each join was found", () => {
    expect(readsLine({ reads: [{ schema: "crm", name: "organizations_raw" }] })).toBe("reads crm.organizations_raw");
    expect(readsLine({ engine: "MergeTree" })).toBeNull();
    const target = { schema: "crm", table: "organizations", column: "id" };
    expect(joinLabel({ ...target, declared: true })).toBe("→ crm.organizations.id (declared)");
    expect(joinLabel({ ...target, overlap: 0.981 })).toBe("→ crm.organizations.id (98% of values match)");
    expect(joinLabel({ ...target, overlap: 0.11 }, true)).toBe("partly → crm.organizations.id (11% of values match)");
    expect(joinLabel(target, false, "read together in 3 of the team's query runs")).toBe(
      "→ crm.organizations.id (read together in 3 of the team's query runs)",
    );
  });

  it("names the dataset built over a table, not the ones that only join it", () => {
    const models = modelsByTable([
      {
        ref: "mrr_monthly",
        label: "MRR",
        status: "verified",
        spec: {
          grain: "one row per item at each month's end",
          usage_guidance: "Use for MRR.",
          snapshot: { at: "month" },
        },
        tables: ["public.subscription_items", "public.accounts"],
      },
      {
        ref: "accounts",
        label: "Accounts",
        status: "proposed",
        spec: { grain: "one row per account" },
        tables: ["public.accounts"],
      },
    ]);
    expect(models.get("public.subscription_items")?.map((m) => m.ref)).toEqual(["mrr_monthly"]);
    expect(models.get("public.accounts")?.map((m) => m.ref)).toEqual(["accounts"]);
    expect(modelledLine(models.get("public.subscription_items")?.[0] as never)).toBe(
      "Modelled as mrr_monthly, a snapshot (a longer period reads its last): one row per item at each month's end. Use for MRR.",
    );
    expect(modelledLine(models.get("public.accounts")?.[0] as never)).toBe(
      "Modelled as accounts (proposed): one row per account",
    );
  });

  it("hints at a snapshot (an entity's key beside a date) and at figures by name, for whoever models it", () => {
    const col = (name: string, type: string, roles: string[] = []) => ({ name, type, roles });
    const usage = shapeHints({
      columns: [col("org_id", "String"), col("day", "Date", ["time"]), col("events", "UInt64")],
      build: { engine: "ReplacingMergeTree", sortingKey: "org_id, day" },
      primaryKey: [],
    });
    expect(usage).toEqual([
      expect.stringMatching(/^It may be a snapshot: its key is org_id and day.*snapshot: \{ at: day \}/),
    ]);
    const kpis = shapeHints({
      columns: [col("org_id", "String"), col("metric_name", "LowCardinality(String)"), col("value", "Float64")],
      build: { engine: "MergeTree", sortingKey: "org_id, metric_name" },
      primaryKey: [],
    });
    expect(kpis).toEqual([
      expect.stringMatching(/each metric_name is its own figure in value.*one measure per metric_name/),
    ]);
    // Events keyed by their own id aren't snapshots, whatever dates they have.
    expect(
      shapeHints({
        columns: [
          col("id", "bigint", ["key"]),
          col("created_at", "timestamptz", ["time"]),
          col("day", "date", ["time"]),
        ],
        build: null,
        primaryKey: ["id"],
      }),
    ).toEqual([]);
  });
});

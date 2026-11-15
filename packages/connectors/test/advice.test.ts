// Each database's advice, on statements as its check reads them: ClickHouse refuses a ReplacingMergeTree
// read without FINAL and a Collapsing one without its sign, and warns on a SummingMergeTree read unaggregated; Postgres
// warns when integers are divided; MySQL says what to write instead of the forms it lacks. Pure: no server.
import { describe, expect, it } from "vitest";
import { type AdvisedTable, dialectFor, parseClickHouseError, type StatementInfo } from "../src";

const statement = (over: Partial<StatementInfo>): StatementInfo => ({
  tables: [],
  literals: [],
  params: [],
  identifiers: [],
  aggregates: [],
  joins: 0,
  references: [],
  returned: [],
  stars: [],
  ...over,
});
const table = (name: string, build: AdvisedTable["build"], columns: Record<string, string> = {}): AdvisedTable => ({
  schema: "billing",
  name,
  build,
  columns: new Map(Object.entries(columns).map(([c, type]) => [c, { type }])),
});

describe("ClickHouse", () => {
  const { advice } = dialectFor("clickhouse");
  const read = (name: string, final?: boolean) => ({
    schema: "billing",
    name,
    alias: `billing.${name}`,
    ...(final === undefined ? {} : { final }),
  });

  it("refuses a ReplacingMergeTree read without FINAL, a cloud one too, and lets it through with FINAL", () => {
    const subs = table("subs", { engine: "SharedReplacingMergeTree", engineColumns: ["version"] });
    const without = advice.check(statement({ tables: [read("subs", false)] }), [subs]);
    expect(without.refuse).toMatch(
      /^billing\.subs is a ReplacingMergeTree: .* Read it with FINAL to count each key once: from billing\.subs FINAL, or from billing\.subs AS t FINAL/,
    );
    expect(advice.check(statement({ tables: [read("subs", true)] }), [subs])).toEqual({ warnings: [] });
  });

  it("refuses a Collapsing table read without summing its sign, and lets one that sums it, or reads FINAL, through", () => {
    const moves = table("moves", { engine: "CollapsingMergeTree", engineColumns: ["sign"] });
    const counted = advice.check(statement({ tables: [read("moves")] }), [moves]);
    expect(counted.refuse).toMatch(/billing\.moves is a CollapsingMergeTree by sign: .* Count it with sum\(sign\)/);
    // where sign = 1 still counts a row a later -1 cancels.
    const filtered = statement({
      tables: [read("moves")],
      references: [{ qualifier: "billing.moves", column: "sign" }],
    });
    expect(advice.check(filtered, [moves]).refuse).toMatch(/Count it with sum\(sign\)/);
    const summed = statement({ tables: [read("moves")], aggregated: [{ qualifier: "billing.moves", column: "sign" }] });
    expect(advice.check(summed, [moves]).refuse).toBeUndefined();
    expect(advice.check(statement({ tables: [read("moves", true)] }), [moves])).toEqual({ warnings: [] });
  });

  it("warns on a SummingMergeTree read without aggregating, and leaves tables it doesn't know alone", () => {
    const totals = table("totals", { engine: "SummingMergeTree" });
    expect(advice.check(statement({ tables: [read("totals")] }), [totals]).warnings).toEqual([
      expect.stringMatching(/^billing\.totals is a SummingMergeTree: .* read it with sum\(\) by its key\.$/),
    ]);
    // Any aggregate over its columns (sumIf(a * b, …) too), or FINAL, reads it summed.
    const summed = statement({ tables: [read("totals")], aggregated: [{ qualifier: "billing.totals", column: "n" }] });
    expect(advice.check(summed, [totals])).toEqual({ warnings: [] });
    expect(advice.check(statement({ tables: [read("totals", true)] }), [totals])).toEqual({ warnings: [] });
    // Not learned yet: no engine to go by, so nothing is held up.
    expect(advice.check(statement({ tables: [read("subs", false)] }), [null])).toEqual({ warnings: [] });
  });

  it("reads an error's code from the client, or from the message's end, before the server's version", () => {
    const message =
      "Code: 184. DB::Exception: Aggregate function sum(x) is found inside another aggregate function. (ILLEGAL_AGGREGATION) (version 26.8.1.1)";
    expect(parseClickHouseError({ message }).code).toBe("ILLEGAL_AGGREGATION");
    expect(parseClickHouseError({ message: "x", type: "NOT_IMPLEMENTED" }).code).toBe("NOT_IMPLEMENTED");
    expect(parseClickHouseError({ message: "Something else went wrong." }).code).toBeUndefined();
  });

  it("names the fix for the errors it's known for, by their code", () => {
    expect(advice.hint({ kind: "other", message: "…", code: "ILLEGAL_AGGREGATION" }, "")).toMatch(
      /aggregate in a subquery/,
    );
    expect(advice.hint({ kind: "other", message: "…", code: "NOT_IMPLEMENTED" }, "")).toMatch(/correlated subquery/);
    expect(advice.hint({ kind: "other", message: "…", code: "TOO_SLOW" }, "")).toBeNull();
    // FINAL before the alias doesn't parse: it's told where FINAL goes.
    expect(advice.hint({ kind: "syntax", message: "…" }, "select count() from billing.subs FINAL AS s")).toMatch(
      /FINAL comes after the table's alias/,
    );
    expect(advice.countDistinctWhere("account_id", "status = 'active'")).toBe(
      "uniqExactIf(account_id, status = 'active')",
    );
  });
});

describe("Postgres", () => {
  const { advice } = dialectFor("postgres");
  const accounts = table("accounts", null, { paid: "integer", total: "bigint", rate: "numeric(12,2)" });
  const reads = { tables: [{ schema: "billing", name: "accounts", alias: "a" }] };

  it("warns when integers are divided, a count or an integer column on each side", () => {
    const counts = advice.check(
      statement({ ...reads, divisions: [{ left: { count: true }, right: { count: true } }] }),
      [accounts],
    );
    expect(counts.warnings).toEqual([
      "count(…) / count(…) divides integers, so Postgres rounds it down: cast one side first (count(…)::numeric / count(…)).",
    ]);
    const columns = statement({
      ...reads,
      divisions: [{ left: { qualifier: "a", column: "paid" }, right: { qualifier: null, column: "total" } }],
    });
    expect(advice.check(columns, [accounts]).warnings).toEqual([
      expect.stringContaining("a.paid / total divides integers"),
    ]);
  });

  it("leaves a division alone when one side isn't an integer", () => {
    const mixed = statement({
      ...reads,
      divisions: [{ left: { qualifier: "a", column: "rate" }, right: { count: true } }],
    });
    expect(advice.check(mixed, [accounts])).toEqual({ warnings: [] });
    expect(advice.countDistinctWhere("account_id", "status = 'active'")).toBe(
      "count(distinct account_id) filter (where status = 'active')",
    );
  });
});

describe("MySQL", () => {
  const { advice } = dialectFor("mysql");

  it("says what to write instead of the forms it lacks, when a statement doesn't parse", () => {
    const syntax = { kind: "syntax" as const, message: "…" };
    expect(advice.hint(syntax, "select count(*) filter (where paid) from invoices")).toMatch(/^MySQL has no FILTER/);
    expect(advice.hint(syntax, "select * from t where name ilike 'a%'")).toMatch(/no ILIKE/);
    // A form inside a quoted value isn't the statement's: another syntax error gets no unrelated fix.
    expect(advice.hint(syntax, "select 'ilike filter (where x)' as note frm t")).toBeNull();
    // Only for a statement that didn't parse: a timeout with the same words says nothing of them.
    expect(advice.hint({ kind: "timeout", message: "…" }, "select x::numeric from t")).toBeNull();
    expect(advice.countDistinctWhere("account_id", "status = 'active'")).toBe(
      "count(distinct case when status = 'active' then account_id end)",
    );
  });
});

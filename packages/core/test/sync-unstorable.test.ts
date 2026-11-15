// A source's strings that Postgres can't keep: a NUL inside a String. Learning finishes, keeping no values at all
//; a query's kept rows hold them with U+FFFD in place of the NUL. Skipped when ClickHouse isn't up.
import { clickhouseAvailable } from "@opendash/evals/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runQuery } from "../src";
import { hasNul, storable } from "../src/storable";
import { type LearnedSource, learnedSource } from "./helpers/learned-source";

const available = await clickhouseAvailable();
if (!available) console.warn("ClickHouse isn't running (pnpm clickhouse:up): skipping the unstorable values tests.");

describe("values Postgres can't keep", () => {
  it("are kept with U+FFFD for each NUL, however deep; anything else as it is", () => {
    const nul = String.fromCharCode(0);
    expect(hasNul(`a${nul}b`)).toBe(true);
    expect(storable({ top: [{ value: `a${nul}${nul}b`, freq: 2 }], n: 3, ok: "web", none: null })).toEqual({
      top: [{ value: "a��b", freq: 2 }],
      n: 3,
      ok: "web",
      none: null,
    });
    expect(storable([[1, `x${nul}`, true]])).toEqual([[1, "x�", true]]);
  });
});

describe.skipIf(!available)("learning a ClickHouse source with NULs in its strings", () => {
  let s: LearnedSource;
  const p = () => s.clickhouse?.prefix ?? "";
  beforeAll(async () => {
    s = await learnedSource({
      dialect: "clickhouse",
      clickhouseSetup: [
        "create table {prefix}public.submissions (id Int64, source_type String, code FixedString(4)) engine = MergeTree order by id",
        "insert into {prefix}public.submissions values (1, 'web', 'AB'), (2, concat('a', char(0), 'b'), 'CD'), (3, 'api', 'EF'), (4, 'web', 'AB')",
      ],
    });
  }, 300_000);
  afterAll(async () => {
    await s?.close();
  });

  const column = async (name: string) =>
    (
      await s.t.owner<{ id: string; profile: { top?: unknown } }[]>`
        select id, profile from app.catalog_object
        where connection_id = ${s.connectionId} and fq_name = ${`${p()}public.submissions.${name}`}`
    )[0];

  it("finishes, profiling each column and keeping none of its values", async () => {
    const [run] = await s.t.owner<{ status: string }[]>`
      select status from app.sync_run where connection_id = ${s.connectionId} order by created_at desc limit 1`;
    expect(run?.status).toBe("succeeded");
    for (const name of ["source_type", "code"]) {
      const c = await column(name);
      expect(c?.profile).toMatchObject({ ndv: expect.any(Number) });
      expect(c?.profile).not.toHaveProperty("top");
    }
  });

  it("records a query whose rows hold a NUL, the NUL shown as U+FFFD", async () => {
    const out = await runQuery(s.deps, {
      orgId: s.orgId,
      connectionId: s.connectionId,
      sql: `select id, source_type from ${p()}public.submissions order by id`,
      mode: "execute",
      requester: { type: "eval", id: null },
    });
    expect(out.status).toBe("succeeded");
    expect(out.rows.map((r) => r[1])).toEqual(["web", "a�b", "api", "web"]);
    const [kept] = await s.t.owner<{ preview: unknown[][] }[]>`
      select preview from app.query_run where id = ${out.queryRunId}`;
    expect(kept?.preview.map((r) => r[1])).toEqual(["web", "a�b", "api", "web"]);
  });
});

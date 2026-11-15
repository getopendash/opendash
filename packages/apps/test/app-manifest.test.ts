// An App's manifest: no pages or sections, its code is its page. What its code may ask of a
// query (a key, paging, all rows, conditions, totals, work, actions) is declared on the query and checked here, so the
// server can hold every request to it.
import { describe, expect, it } from "vitest";
import {
  bindFacet,
  bindQuery,
  bindTotals,
  type CheckContext,
  checkDefinition,
  type Definition,
} from "../src/dashboard";
import { ACME } from "./fixtures/acme-catalog";
import { proof, SOURCE } from "./fixtures/proof";

const ctx: CheckContext = { catalogs: { [SOURCE]: ACME } };
const problems = (d: unknown) => {
  const r = checkDefinition(d, ctx);
  return r.ok ? [] : r.problems.map((p) => `${p.path}: ${p.message}`);
};
/** The proof, its accounts declaring what its code may ask of them. */
const app = (fn: (d: Definition) => void = () => {}): Definition => {
  const d = structuredClone(proof());
  const accounts = d.queries.q_accounts as Definition["queries"][string];
  Object.assign(accounts, { key: "id", rows: { pageSizes: [25, 50], conditions: true, totals: { mrr: "sum" } } });
  fn(d);
  return d;
};

describe("an App's manifest", () => {
  it("checks with no pages, its queries declaring what code may ask of them", () => {
    expect(problems(app())).toEqual([]);
    expect(
      problems(
        app((d) => {
          d.summaries = { s_week: { queries: ["q_mrr", "q_accounts"] } };
        }),
      ),
    ).toEqual([]);
  });

  it("refuses pages, and any version but 2", () => {
    expect(problems(app((d) => Object.assign(d, { pages: [] })))).toEqual([expect.stringMatching(/pages/)]);
    expect(problems(app((d) => Object.assign(d, { version: 1 })))).toEqual([expect.stringMatching(/^version: /)]);
  });

  it("refuses a key, a total or a summary that names what isn't there", () => {
    const wrong = problems(
      app((d) => {
        Object.assign(d.queries.q_accounts as object, { key: "owner", rows: { totals: { seats: "sum" } } });
        d.summaries = { s_week: { queries: ["q_nowhere"] } };
      }),
    );
    expect(wrong).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^queries\.q_accounts\.key: .*owner isn't/),
        expect.stringMatching(/^queries\.q_accounts\.rows\.totals\.seats: /),
        expect.stringMatching(/^summaries\.s_week\.queries: There's no query q_nowhere/),
      ]),
    );
  });

  it("puts work and actions only on rows that have a key", () => {
    const wrong = problems(
      app((d) => {
        const q = d.queries.q_accounts as Record<string, unknown>;
        delete q.key;
        q.work = { statuses: ["Open", "Done"] };
      }),
    );
    expect(wrong).toEqual(expect.arrayContaining([expect.stringMatching(/say which column is its key/)]));
  });
});

describe("what an App's code may ask of a query", () => {
  const at = { now: new Date("2026-10-15T12:00:00Z"), tz: "UTC" };
  const d = () => {
    const parsed = checkDefinition(app(), ctx);
    if (!parsed.ok) throw new Error("the App doesn't check");
    return parsed.definition;
  };

  it("pages by the sizes it declares, and no other", () => {
    expect(bindQuery(d(), "q_accounts", { pageSize: 25 }, at).spec).toBeTruthy();
    expect(() => bindQuery(d(), "q_accounts", { pageSize: 30 }, at)).toThrow(/doesn't page by 30/);
  });

  it("takes conditions and facets only where it declares them", () => {
    expect(bindQuery(d(), "q_accounts", { where: [["plan", "in", ["Growth"]]] }, at).spec).toBeTruthy();
    expect(bindFacet(d(), "q_accounts", "plan", {}, at)).toBeTruthy();
    const none = d();
    delete none.queries.q_accounts?.rows;
    expect(() => bindQuery(none, "q_accounts", { where: [["plan", "in", ["Growth"]]] }, at)).toThrow(
      /takes no conditions/,
    );
    expect(() => bindFacet(none, "q_accounts", "plan", {}, at)).toThrow(/has no filters/);
  });

  it("is asked for one record by its key, and totals by the query", () => {
    const one = bindQuery(d(), "q_accounts", { record: 42 }, at).spec;
    expect(JSON.stringify(one.where)).toContain('["id","=",42]');
    expect(bindTotals(d(), "q_accounts", {}, at).measures).toEqual({ mrr: ["sum", "mrr"] });
    expect(() => bindTotals(d(), "q_mrr", {}, at)).toThrow(/has no totals/);
  });
});

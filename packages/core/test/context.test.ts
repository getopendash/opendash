// Context v0: the glossary and guides. Only the version an admin approved reaches the analyst; an edit waits as a
// draft while the released version keeps answering; a term's column mapping must exist in the source's catalog;
// pinned guides stay short; search finds released items only; a deleted item stops reaching it at once.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  approveContext,
  ContextProblem,
  contextForRun,
  deleteContextItem,
  getContextItem,
  listContext,
  PINNED_GUIDE_MAX,
  saveGuide,
  saveTerm,
  searchContext,
} from "../src";
import { type LearnedSource, learnedSource } from "./helpers/learned-source";

let s: LearnedSource;
const ctx = () => ({ orgId: s.orgId, userId: s.userId });
const problem = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (error) {
    if (error instanceof ContextProblem) return error.message;
    throw error;
  }
};
const ENTERPRISE = `term: Enterprise
means: Accounts with 1,000 or more employees.
synonyms: [large accounts]
maps_to:
  column: public.accounts.employee_band
  values: ["1000+"]
`;

beforeAll(async () => {
  s = await learnedSource();
}, 300_000);
afterAll(async () => {
  await s?.close();
});

describe("the glossary", () => {
  let id = "";

  it("checks a term's mapping against the catalog, and keeps a new one a draft", async () => {
    expect(
      await problem(
        s.tenant((tx) =>
          saveTerm(tx, ctx(), { body: ENTERPRISE.replace("employee_band", "size"), connectionId: s.connectionId }),
        ),
      ),
    ).toMatch(/public.accounts.size isn't a column/);
    expect(await problem(s.tenant((tx) => saveTerm(tx, ctx(), { body: ENTERPRISE })))).toMatch(/which source/);
    expect(await problem(s.tenant((tx) => saveTerm(tx, ctx(), { body: "term: [oops" })))).toMatch(/valid YAML/);
    expect(
      await problem(s.tenant((tx) => saveTerm(tx, ctx(), { body: ENTERPRISE, connectionId: "not-a-source" }))),
    ).toMatch(/doesn't exist/);
    ({ id } = await s.tenant((tx) => saveTerm(tx, ctx(), { body: ENTERPRISE, connectionId: s.connectionId })));
    expect((await s.tenant((tx) => listContext(tx, s.orgId, "term")))[0]).toMatchObject({
      title: "Enterprise",
      status: "draft",
      releasedVersion: null,
      synonyms: ["large accounts"],
      mapsTo: { column: "public.accounts.employee_band", values: ["1000+"] },
    });
    expect((await s.tenant((tx) => contextForRun(tx, s.orgId, s.connectionId))).terms).toEqual([]);
  });

  it("reaches the analyst once approved, and an edit waits as a draft while v1 answers", async () => {
    // An approval names the version reviewed: a stale one approves nothing.
    expect(await s.tenant((tx) => approveContext(tx, ctx(), [{ id, version: 2 }]))).toEqual([]);
    expect(await s.tenant((tx) => approveContext(tx, ctx(), [{ id, version: 1 }]))).toEqual([id]);
    const run = await s.tenant((tx) => contextForRun(tx, s.orgId, s.connectionId));
    expect(run.terms).toEqual([
      expect.objectContaining({ id, version: 1, spec: expect.objectContaining({ term: "Enterprise" }) }),
    ]);
    await s.tenant((tx) =>
      saveTerm(tx, ctx(), { id, body: ENTERPRISE.replace("1,000 or more", "over 999"), connectionId: s.connectionId }),
    );
    const after = await s.tenant((tx) => contextForRun(tx, s.orgId, s.connectionId));
    expect(after.terms[0]).toMatchObject({ version: 1, spec: { means: "Accounts with 1,000 or more employees." } });
    const detail = await s.tenant((tx) => getContextItem(tx, s.orgId, id));
    expect(detail).toMatchObject({ version: 2, releasedVersion: 1, status: "draft", released: { version: 1 } });
    expect(detail?.versions.map((v) => v.version)).toEqual([2, 1]);
    // Its draft taken back (a reject, a revert puts current_version back to 1): the next save is version 3, never a
    // second version 2.
    await s.t.owner`update app.context_item set current_version = 1 where id = ${id}`;
    const next = await s.tenant((tx) =>
      saveTerm(tx, ctx(), {
        id,
        body: ENTERPRISE.replace("1,000 or more", "a thousand or more"),
        connectionId: s.connectionId,
      }),
    );
    expect(next.version).toBe(3);
  });

  it("checks the tables a term is not, on its source", async () => {
    const PAID = `term: Paid plans
means: The plans customers pay for.
not: [billing.invoices]
`;
    expect(await problem(s.tenant((tx) => saveTerm(tx, ctx(), { body: PAID })))).toMatch(/which source/);
    expect(
      await problem(
        s.tenant((tx) =>
          saveTerm(tx, ctx(), {
            body: PAID.replace("billing.invoices", "billing.nothing"),
            connectionId: s.connectionId,
          }),
        ),
      ),
    ).toMatch(/billing.nothing isn't a table/);
    expect(
      await problem(s.tenant((tx) => saveTerm(tx, ctx(), { body: PAID.replace("[billing.invoices]", "[invoices]") }))),
    ).toMatch(/schema.table/);
    const { id: paid } = await s.tenant((tx) => saveTerm(tx, ctx(), { body: PAID, connectionId: s.connectionId }));
    const [kept] = await s
      .tenant((tx) => listContext(tx, s.orgId, "term"))
      .then((all) => all.filter((t) => t.id === paid));
    expect(kept).toMatchObject({ title: "Paid plans" });
  });

  it("refuses a second term with the same name", async () => {
    expect(
      await problem(s.tenant((tx) => saveTerm(tx, ctx(), { body: ENTERPRISE, connectionId: s.connectionId }))),
    ).toMatch(/already a term/);
  });
});

describe("guides", () => {
  it("keeps pinned guides short, anchors one to a table, and searches released ones only", async () => {
    expect(
      await problem(
        s.tenant((tx) => saveGuide(tx, ctx(), { title: "Long", body: "x".repeat(PINNED_GUIDE_MAX + 1), pinned: true })),
      ),
    ).toMatch(/keep it under/);
    // An anchor names a table the source has.
    expect(
      await problem(
        s.tenant((tx) =>
          saveGuide(tx, ctx(), { title: "Nowhere", body: "x", connectionId: s.connectionId, table: "billing.nope" }),
        ),
      ),
    ).toMatch(/billing.nope isn't a table/);
    expect(
      await problem(s.tenant((tx) => saveGuide(tx, ctx(), { title: "Odd", body: "x", connectionId: "nope" }))),
    ).toMatch(/doesn't exist/);
    const pinned = await s.tenant((tx) =>
      saveGuide(tx, ctx(), {
        title: "Ignore test accounts",
        body: "Leave out accounts where is_test is true.",
        pinned: true,
      }),
    );
    const anchored = await s.tenant((tx) =>
      saveGuide(tx, ctx(), {
        title: "Invoice totals include tax",
        body: "total_cents includes tax; use subtotal_cents for revenue before tax.",
        connectionId: s.connectionId,
        table: "billing.invoices",
      }),
    );
    expect(await s.tenant((tx) => searchContext(tx, s.orgId, s.connectionId, "tax"))).toEqual([]);
    await s.tenant((tx) =>
      approveContext(tx, ctx(), [
        { id: pinned.id, version: 1 },
        { id: anchored.id, version: 1 },
      ]),
    );
    const run = await s.tenant((tx) => contextForRun(tx, s.orgId, s.connectionId));
    expect(run.pinned.map((g) => g.title)).toEqual(["Ignore test accounts"]);
    expect(run.anchored).toEqual([
      expect.objectContaining({ title: "Invoice totals include tax", table: "billing.invoices" }),
    ]);
    const found = await s.tenant((tx) => searchContext(tx, s.orgId, s.connectionId, "tax"));
    expect(found.map((f) => f.title)).toContain("Invoice totals include tax");
    expect(
      (await s.tenant((tx) => searchContext(tx, s.orgId, s.connectionId, "large accounts"))).map((f) => f.title),
    ).toContain("Enterprise");
  });

  it("stops reaching the analyst once deleted", async () => {
    const [g] = await s.tenant((tx) => listContext(tx, s.orgId, "guide"));
    await s.tenant((tx) => deleteContextItem(tx, s.orgId, g?.id as string));
    const run = await s.tenant((tx) => contextForRun(tx, s.orgId, s.connectionId));
    expect([...run.pinned, ...run.anchored].map((x) => x.id)).not.toContain(g?.id);
  });
});

// Vectors with a stub embedder, no provider: a released guide and the source's tables embedded once per text,
// again only what changed, and the rows of what's gone removed; the analyst's search finding a guide by meaning that
// its words miss, never below the floor, with another model or once it's deleted; and the tick queueing a workspace
// only when it can embed and something changed.
import { withSystemOn } from "@opendash/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  approveContext,
  deleteContextItem,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  type Embedder,
  embedOrganization,
  queueStaleEmbeddings,
  saveGuide,
  searchContext,
  vectorSearch,
} from "../src";
import { type LearnedSource, learnedSource } from "./helpers/learned-source";

let s: LearnedSource;
const ctx = () => ({ orgId: s.orgId, userId: s.userId });

// Words that mean the same, as a model hears them: the stub maps each to one word, then counts words into places.
const SAME: Record<string, string> = { lost: "churn", leaving: "churn", cancelled: "churn", churned: "churn" };
const vectorOf = (text: string) => {
  const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  for (const raw of text.toLowerCase().match(/[a-z]{3,}/g) ?? []) {
    const word = SAME[raw] ?? raw;
    let h = 7;
    for (const c of word) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    v[h % EMBEDDING_DIMENSIONS] = (v[h % EMBEDDING_DIMENSIONS] ?? 0) + 1;
  }
  const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
  return v.map((x) => x / norm);
};
const sent: string[] = [];
const stub: Embedder = {
  model: EMBEDDING_MODEL,
  embed: async (texts) => {
    sent.push(...texts);
    return texts.map(vectorOf);
  },
};
const query = (text: string, model = EMBEDDING_MODEL) => ({ model, vector: vectorOf(text) });
const embedded = async () =>
  (await s.t.owner<{ n: number }[]>`select count(*)::int as n from app.embedding where org_id = ${s.orgId}`)[0]?.n ?? 0;

let churn = "";
beforeAll(async () => {
  s = await learnedSource();
  const guide = await s.tenant((tx) =>
    saveGuide(tx, ctx(), {
      title: "Counting churn",
      body: "A customer churns in the month their last subscription ended. Count churn by that month, not by the cancel request.",
      connectionId: s.connectionId,
    }),
  );
  churn = guide.id;
  await s.tenant((tx) => approveContext(tx, ctx(), [{ id: churn, version: 1 }]));
}, 300_000);

afterAll(async () => {
  await s?.close();
});

describe("embedding a workspace", () => {
  it("embeds each released item and table once, again only what changed, and removes what's gone", async () => {
    const first = await embedOrganization(s.deps, s.orgId, stub);
    expect(first.embedded).toBeGreaterThan(1);
    expect(first).toMatchObject({ unchanged: 0, removed: 0 });
    expect(await embedded()).toBe(first.embedded);
    // The guide's text as the search reads it, and a table's with its columns (never a value).
    expect(sent.find((t) => t.startsWith("Guide: Counting churn"))).toContain("Count churn by that month");
    expect(sent.some((t) => t.startsWith("Table: ") && t.includes("Columns: "))).toBe(true);

    const before = sent.length;
    expect(await embedOrganization(s.deps, s.orgId, stub)).toEqual({
      embedded: 0,
      unchanged: first.embedded,
      removed: 0,
    });
    expect(sent.length).toBe(before);

    const extra = await s.tenant((tx) =>
      saveGuide(tx, ctx(), {
        title: "Refund timing",
        body: "Refunds count on the day they're paid back.",
        connectionId: s.connectionId,
      }),
    );
    await s.tenant((tx) => approveContext(tx, ctx(), [{ id: extra.id, version: 1 }]));
    expect(await embedOrganization(s.deps, s.orgId, stub)).toMatchObject({ embedded: 1, removed: 0 });
    await s.tenant((tx) => deleteContextItem(tx, s.orgId, extra.id));
    expect(await embedOrganization(s.deps, s.orgId, stub)).toMatchObject({ embedded: 0, removed: 1 });
  });

  it("finds an approved guide by meaning that its words miss, above the floor, with this model only", async () => {
    // Nothing in the guide says "lost": by its words, nothing approved matches.
    expect(await s.tenant((tx) => searchContext(tx, s.orgId, s.connectionId, "lost customers"))).toEqual([]);
    const found = await s.tenant((tx) =>
      searchContext(tx, s.orgId, s.connectionId, "lost customers", 5, query("lost customers")),
    );
    expect(found.map((f) => f.title)).toEqual(["Counting churn"]);
    expect(found[0]?.body).toContain("Count churn by that month");

    const kinds = ["guide", "term", "verified_query"];
    expect(await s.tenant((tx) => vectorSearch(tx, query("weather forecast for tuesday"), { kinds }))).toEqual([]);
    expect(await s.tenant((tx) => vectorSearch(tx, query("lost customers", "another/model@1024"), { kinds }))).toEqual(
      [],
    );
    // A deleted guide is never found, even before the next batch removes its row.
    await s.tenant((tx) => deleteContextItem(tx, s.orgId, churn));
    expect(await s.tenant((tx) => vectorSearch(tx, query("lost customers"), { kinds }))).toEqual([]);
  });
});

describe("the tick", () => {
  const queued = async () =>
    (
      await s.t.owner<{ n: number }[]>`
        select count(*)::int as n from pgboss.job where name = 'embed.batch' and data->>'orgId' = ${s.orgId}
          and state in ('created', 'retry')`
    )[0]?.n ?? 0;
  const tick = (deploymentKey: boolean) =>
    queueStaleEmbeddings({
      withSystem: (fn) => withSystemOn(s.t.system, fn),
      withTenant: s.deps.withTenant,
      boss: s.boss,
      deploymentKey,
    });

  it("queues a workspace that can embed only when something changed since its last batch, once", async () => {
    await embedOrganization(s.deps, s.orgId, stub);
    await tick(true);
    expect(await queued()).toBe(0);
    await s.t.owner`update app.catalog_object set updated_at = now() + interval '1 second'
      where org_id = ${s.orgId} and kind = 'table'`;
    await tick(true);
    await tick(true);
    expect(await queued()).toBe(1);
    // Without a key (no deployment key, none of its own), it never is.
    await s.t.owner`delete from pgboss.job where name = 'embed.batch' and data->>'orgId' = ${s.orgId}`;
    await tick(false);
    expect(await queued()).toBe(0);
  });
});

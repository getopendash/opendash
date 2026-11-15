// Search v0 (retrieval v1, lexical): released knowledge and tables by full text and trigram, fused and weighed by
// trust; the palette's conversations read as the viewer may; never memory, never another workspace's.
import { uuidv7 } from "@opendash/db";
import { createOrg, withTenantOn } from "@opendash/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  checkDefinitions,
  contextSearch,
  demoPack,
  fuse,
  installDefinitions,
  listDefinitions,
  searchWorkspace,
  submitQuestion,
  verifyDefinitions,
} from "../src";
import { type LearnedSource, learnedSource } from "./helpers/learned-source";

let s: LearnedSource;
const ctx = () => ({ orgId: s.orgId, userId: s.userId });
const titles = async (q: string) => (await s.tenant((tx) => contextSearch(tx, q))).map((h) => h.title);

beforeAll(async () => {
  s = await learnedSource();
  await s.tenant((tx) =>
    installDefinitions(tx, ctx(), s.connectionId, demoPack("postgres"), { status: "proposed", source: "pack" }),
  );
  await checkDefinitions(s.deps, { orgId: s.orgId, connectionId: s.connectionId });
  const list = await s.tenant((tx) => listDefinitions(tx, s.orgId, { connectionId: s.connectionId }));
  await s.tenant((tx) =>
    verifyDefinitions(
      tx,
      ctx(),
      list.map((d) => d.id),
    ),
  );
}, 300_000);

afterAll(async () => {
  await s?.close();
});

describe("search", () => {
  it("puts an exact name first, finds a synonym, and forgives a typo", async () => {
    expect((await titles("paid seats"))[0]).toBe("Paid seats");
    expect(await titles("monthly recurring revenue")).toContain("Monthly recurring revenue");
    expect(await titles("churnd")).toContain("Churned MRR");
    // Equally named and verified: the one whose text matches better first.
    expect((await titles("churn"))[0]).toBe("Churned MRR");
    expect(await titles("")).toEqual([]);
  });

  it("finds a source's tables by name", async () => {
    const hits = await s.tenant((tx) => contextSearch(tx, "subscription_items", { kinds: ["table"] }));
    expect(hits.map((h) => [h.kind, h.title])).toContainEqual(["table", "public.subscription_items"]);
    expect(hits.every((h) => h.kind === "table" && h.status === "observed")).toBe(true);
  });

  it("weighs trust: an item flagged for review sinks below a verified one that matches as well", () => {
    const row = (id: string, status: string) => ({
      kind: "metric" as const,
      id,
      connection_id: null,
      title: id,
      key: id,
      status,
      fts: 0.5,
      sim: 1,
      exact: true,
    });
    expect(fuse([row("flagged", "needs_review"), row("verified", "verified")]).map((h) => h.id)).toEqual([
      "verified",
      "flagged",
    ]);
    // An exact name ahead of a description that matches better.
    const described = { ...row("described", "verified"), fts: 0.9, sim: 0.6, exact: false };
    const named = { ...row("named", "verified"), fts: 0.1, sim: 1, exact: true };
    expect(fuse([described, named])[0]?.id).toBe("named");
  });

  it("never shows memory, and nothing of another workspace", async () => {
    const memory = uuidv7();
    await s.t.owner`
      insert into app.context_item (org_id, id, kind, scope, scope_id, path, slug, title, status, current_version,
        released_version, owner_id)
      values (${s.orgId}, ${memory}, 'memory', 'personal', ${s.userId}, '/memory/me.md', 'churn-note',
        'Churn note to self', 'verified', 1, 1, ${s.userId})`;
    await s.t.owner`
      insert into app.context_item_version (org_id, item_id, version, body, body_hash, spec, source)
      values (${s.orgId}, ${memory}, 1, 'churn', 'h', '{}'::jsonb, 'user')`;
    expect(await titles("churn note")).not.toContain("Churn note to self");
    const other = uuidv7();
    await createOrg(s.t, other, "Other");
    const elsewhere = await withTenantOn(s.t.app, { orgId: other }, (tx) => contextSearch(tx, "churned"));
    expect(elsewhere).toEqual([]);
  });

  it("gathers the palette's groups as the viewer reads them", async () => {
    const r = await submitQuestion(
      { withTenant: s.deps.withTenant, boss: null },
      {
        orgId: s.orgId,
        userId: s.userId,
        connectionId: s.connectionId,
        text: "Why did churn drop?",
        channel: "web",
        model: "m",
      },
    );
    await s.t.owner`update app.run set status = 'failed', error = 'test', finished_at = now() where id = ${r.runId}`;
    const found = await searchWorkspace({ withTenant: s.deps.withTenant }, ctx(), "churn");
    expect(found.knowledge.map((h) => h.title)).toContain("Churned MRR");
    expect(found.conversations.map((c) => c.id)).toContain(r.threadId);
    // Someone else in the workspace doesn't see the private conversation.
    const theirs = await searchWorkspace(
      { withTenant: s.deps.withTenant },
      { orgId: s.orgId, userId: uuidv7() },
      "churn",
    );
    expect(theirs.conversations).toEqual([]);
    expect(theirs.knowledge.map((h) => h.title)).toContain("Churned MRR");
  });
});

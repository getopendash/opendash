// The analyst beside a metric or dataset: an owner or admin attaches one and the analyst
// drafts a change to it, a new version and never a release, refused unless it's theirs to change and made on the
// version it read. The page shows the draft against the released version, and Discard goes back to it.
import { uuidv7 } from "@opendash/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AttachmentProblem,
  attachable,
  checkDefinitions,
  conversationAttachments,
  demoPack,
  discardDraft,
  draftDefinitionChange,
  getDefinition,
  installDefinitions,
  loadSemanticModel,
  releaseDraft,
  saveDefinition,
  submitQuestion,
} from "../src";
import { type LearnedSource, learnedSource } from "./helpers/learned-source";

let s: LearnedSource;
const bob = uuidv7();
const carol = uuidv7();
let mrr = "";
let mrrMonthly = "";
let churned = "";
let thread = "";
let runId = "";
let released = "";

const as = (userId: string) => ({ orgId: s.orgId, userId });
/** The analyst's change to MRR: refunds left out too. */
const changed = () => released.replace("Leaves out test accounts", "Leaves out refunds, test accounts");
// Asks, then ends the run (no worker here), so the conversation takes its next question.
const ask = async (
  attachments: { kind: "metric" | "dataset"; id: string }[],
  options: { threadId?: string; canTryDrafts?: boolean } = {},
) => {
  const r = await submitQuestion(
    { withTenant: s.deps.withTenant, boss: null },
    {
      orgId: s.orgId,
      userId: s.userId,
      connectionId: s.connectionId,
      ...(options.threadId ? { threadId: options.threadId } : {}),
      text: "Leave refunds out of this",
      channel: "web",
      model: "test-model",
      attachments,
      canTryDrafts: options.canTryDrafts ?? true,
    },
  );
  await s.t.owner`update app.run set status = 'failed', error = 'test', finished_at = now() where id = ${r.runId}`;
  return r;
};
const refused = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (error) {
    if (error instanceof AttachmentProblem) return error.message;
    throw error;
  }
};
const draft = (
  userId: string,
  input: Partial<Parameters<typeof draftDefinitionChange>[3]> & { body: string; baseVersion: number },
) =>
  s.tenant((tx) =>
    draftDefinitionChange({ boss: null }, tx, as(userId), {
      kind: "metric",
      name: "mrr",
      connectionId: s.connectionId,
      threadId: thread,
      runId,
      changeNote: "Leaves refunds out",
      ...input,
    }),
  );
const item = async (id: string) =>
  (
    await s.t.owner<
      {
        current_version: number;
        released_version: number | null;
        status: string;
        verified_by: string | null;
      }[]
    >`select current_version, released_version, status, verified_by from app.context_item where id = ${id}`
  )[0];

beforeAll(async () => {
  s = await learnedSource();
  await s.tenant((tx) =>
    installDefinitions(tx, as(s.userId), s.connectionId, demoPack("postgres"), { status: "verified", source: "pack" }),
  );
  const ids = await s.t.owner<{ id: string; slug: string; kind: string }[]>`
    select id, slug, kind from app.context_item where org_id = ${s.orgId} and kind in ('metric', 'dataset')`;
  const id = (kind: string, slug: string) => ids.find((i) => i.kind === kind && i.slug === slug)?.id as string;
  mrr = id("metric", "mrr");
  mrrMonthly = id("dataset", "mrr_monthly");
  churned = id("metric", "churned_mrr");
  // One not released yet: OpenDash proposed it, nobody approved it.
  await s.t.owner`update app.context_item set released_version = null, status = 'proposed', verified_by = null,
    verified_at = null where id = ${churned}`;
  for (const [userId, role] of [
    [s.userId, "owner"],
    [bob, "member"],
    [carol, "admin"],
  ] as const) {
    await s.t.owner`insert into auth.user (id, name, email, email_verified)
      values (${userId}, ${role}, ${`${role}-${userId.slice(-6)}@opendash.test`}, true) on conflict do nothing`;
    await s.t.owner`insert into auth.member (id, organization_id, user_id, role, created_at)
      values (${uuidv7()}, ${s.orgId}, ${userId}, ${role}, now())
      on conflict (organization_id, user_id) do update set role = excluded.role`;
  }
  const [v] = await s.t.owner<{ body: string }[]>`
    select body from app.context_item_version where item_id = ${mrr} and version = 1`;
  released = v?.body as string;
}, 300_000);

afterAll(async () => {
  await s?.close();
});

const unavailable =
  "Something you attached isn't available here: it was removed, isn't shared with you, or is about another source.";

describe("attaching a metric or dataset", () => {
  it("offers released datasets, and attaches one not released yet only for an owner or admin", async () => {
    const all = await s.tenant((tx) => attachable(tx, as(s.userId), s.connectionId));
    expect(all.find((a) => a.id === mrrMonthly)).toMatchObject({ kind: "dataset", meta: "Verified dataset" });
    expect(all.some((a) => a.id === churned)).toBe(false);
    expect(await refused(ask([{ kind: "metric", id: churned }], { canTryDrafts: false }))).toBe(unavailable);
    expect(await refused(ask([{ kind: "metric", id: churned }]))).toBe("ok");
    // A dataset attached as a metric isn't one.
    expect(await refused(ask([{ kind: "metric", id: mrrMonthly }]))).toBe(unavailable);
  });

  it("gives the analyst its YAML only when it's the asker's to change, and one not released only to them", async () => {
    const r = await ask([
      { kind: "metric", id: mrr },
      { kind: "metric", id: churned },
    ]);
    thread = r.threadId;
    runId = r.runId;
    const given = await s.tenant((tx) =>
      conversationAttachments(tx, as(s.userId), thread, s.connectionId, { canTryDrafts: true }),
    );
    expect(given.missing).toBe(0);
    expect(given.items.find((i) => i.id === mrr)).toEqual({
      kind: "metric",
      id: mrr,
      title: "Monthly recurring revenue",
      version: 1,
      name: "mrr",
      released: true,
      editable: true,
      current: { version: 1, body: released, draft: false },
    });
    expect(given.items.find((i) => i.id === churned)).toMatchObject({ released: false, editable: true });
    // No longer one who may edit definitions: read, not changed, and what isn't released is gone.
    const reader = await s.tenant((tx) => conversationAttachments(tx, as(s.userId), thread, s.connectionId));
    expect(reader.items).toEqual([
      {
        kind: "metric",
        id: mrr,
        title: "Monthly recurring revenue",
        version: 1,
        name: "mrr",
        released: true,
        editable: false,
      },
    ]);
    expect(reader.missing).toBe(1);
  });
});

describe("the analyst's draft", () => {
  it("is a new version by the asker, from its run, while Ask keeps the released one", async () => {
    expect(await draft(s.userId, { body: changed(), baseVersion: 1 })).toEqual({
      ok: true,
      id: mrr,
      kind: "metric",
      slug: "mrr",
      title: "Monthly recurring revenue",
      version: 2,
    });
    const [v] = await s.t.owner<
      { source: string; author_id: string; author_run_id: string; change_note: string; body: string }[]
    >`select source, author_id, author_run_id, change_note, body from app.context_item_version
      where item_id = ${mrr} and version = 2`;
    expect(v).toEqual({
      source: "agent",
      author_id: s.userId,
      author_run_id: runId,
      change_note: "Leaves refunds out",
      body: changed(),
    });
    // A draft, not a release: who approved version 1 stays with it.
    expect(await item(mrr)).toEqual({
      current_version: 2,
      released_version: 1,
      status: "draft",
      verified_by: s.userId,
    });
    const model = await s.tenant((tx) => loadSemanticModel(tx, s.orgId, s.connectionId));
    expect(model?.definitions.get("metric:mrr")?.version).toBe(1);
    // The same draft again from the same run (its call cut off after the write) is the version it made.
    expect(await draft(s.userId, { body: changed(), baseVersion: 1 })).toMatchObject({ ok: true, version: 2 });
    expect((await item(mrr))?.current_version).toBe(2);
    // The next question is given the draft to change again.
    const given = await s.tenant((tx) =>
      conversationAttachments(tx, as(s.userId), thread, s.connectionId, { canTryDrafts: true }),
    );
    expect(given.items.find((i) => i.id === mrr)).toMatchObject({
      version: 1,
      current: { version: 2, body: changed(), draft: true },
    });
  });

  it("is refused on a version that moved, with the current one, and when it changes nothing", async () => {
    expect(
      await draft(s.userId, { body: changed().replace("refunds", "refunds and credits"), baseVersion: 1 }),
    ).toEqual({
      ok: false,
      reason: "conflict",
      problems: [expect.stringMatching(/^Someone saved version 2/)],
      current: { version: 2, body: changed() },
    });
    expect(await draft(s.userId, { body: changed(), baseVersion: 2 })).toMatchObject({
      ok: false,
      reason: "unchanged",
    });
    expect(await draft(s.userId, { body: changed().replace("name: mrr", "name: mrr2"), baseVersion: 2 })).toMatchObject(
      { ok: false, reason: "invalid", problems: ["The name can't change: it's mrr."] },
    );
  });

  it("is refused for a member, for an admin who didn't attach it here, and for what isn't attached", async () => {
    expect(await draft(bob, { body: changed(), baseVersion: 2 })).toMatchObject({
      ok: false,
      reason: "forbidden",
      problems: ["Only owners and admins change metrics and datasets."],
    });
    expect(await draft(carol, { body: changed(), baseVersion: 2 })).toMatchObject({ ok: false, reason: "not_found" });
    expect(await draft(s.userId, { kind: "dataset", name: "mrr_monthly", body: "x", baseVersion: 1 })).toMatchObject({
      ok: false,
      reason: "not_found",
    });
    // The asker's role is read now: one who's a member again can't, whatever the run was told.
    await s.t
      .owner`update auth.member set role = 'member' where user_id = ${s.userId} and organization_id = ${s.orgId}`;
    expect(await draft(s.userId, { body: changed(), baseVersion: 2 })).toMatchObject({ reason: "forbidden" });
    await s.t.owner`update auth.member set role = 'owner' where user_id = ${s.userId} and organization_id = ${s.orgId}`;
  });

  it("keeps one OpenDash proposed as proposed", async () => {
    const [v] = await s.t.owner<{ body: string }[]>`
      select body from app.context_item_version where item_id = ${churned} and version = 1`;
    const body = String(v?.body).replace(/^label: .*$/m, "label: Churned MRR, refunds left out");
    expect(await draft(s.userId, { name: "churned_mrr", body, baseVersion: 1 })).toMatchObject({
      ok: true,
      version: 2,
    });
    expect(await item(churned)).toMatchObject({ current_version: 2, released_version: null, status: "proposed" });
  });
});

describe("the draft on its page, and Discard", () => {
  it("shows the released version's YAML beside the draft", async () => {
    const d = await s.tenant((tx) => getDefinition(tx, as(s.userId), mrr));
    expect(d).toMatchObject({
      version: 2,
      releasedVersion: 1,
      body: changed(),
      released: { version: 1, body: released },
    });
    expect(d?.versions.map((v) => [v.version, v.source])).toEqual([
      [2, "agent"],
      [1, "pack"],
    ]);
  });

  it("goes back to the released version, only from the draft seen, and numbers the next version on", async () => {
    const discard = (id: string, expectedVersion: number) =>
      s.tenant((tx) => discardDraft(tx, as(s.userId), { id, expectedVersion }));
    expect(await discard(mrr, 1)).toMatchObject({ ok: false, reason: "conflict" });
    expect(await discard(mrr, 2)).toEqual({ ok: true, version: 1 });
    expect(await item(mrr)).toEqual({
      current_version: 1,
      released_version: 1,
      status: "verified",
      verified_by: s.userId,
    });
    expect((await s.tenant((tx) => getDefinition(tx, as(s.userId), mrr)))?.released).toBeNull();
    expect(await discard(mrr, 1)).toEqual({ ok: false, reason: "invalid", problems: ["There's no draft to discard."] });
    expect(await discard(churned, 2)).toMatchObject({ ok: false, reason: "invalid" });
    // The discarded draft keeps its number: the next save is version 3.
    const saved = await s.tenant((tx) =>
      saveDefinition({ boss: s.boss }, tx, as(s.userId), {
        id: mrr,
        kind: "metric",
        connectionId: s.connectionId,
        body: changed(),
        expectedVersion: 1,
      }),
    );
    expect(saved).toEqual({ ok: true, id: mrr, version: 3 });
    expect(await item(mrr)).toMatchObject({ current_version: 3, released_version: 1, verified_by: s.userId });
  });
});

describe("Release from the page", () => {
  const release = (id: string, expectedVersion: number) =>
    s.tenant((tx) => releaseDraft(tx, as(s.userId), { id, expectedVersion }));
  const sampleOf = async (id: string, version: number) =>
    (
      await s.t.owner<{ value: unknown }[]>`
        select derived->'sample'->'value' as value from app.context_item_version
        where item_id = ${id} and version = ${version}`
    )[0]?.value;

  it("releases only the version seen, once its tests passed", async () => {
    // Version 3 is the person's edit after the Discard, not tested yet.
    expect(await release(mrr, 2)).toMatchObject({ ok: false, reason: "conflict" });
    expect(await release(mrr, 3)).toEqual({
      ok: false,
      reason: "invalid",
      problems: ["Its tests haven't finished: release it once they pass."],
    });
    await s.t.owner`update app.context_item_version set derived = ${s.t.owner.json({ status: "failed", checks: [] })}
      where item_id = ${mrr} and version = 3`;
    expect(await release(mrr, 3)).toMatchObject({
      ok: false,
      problems: ["Its tests failed, so it can't be released."],
    });
    await s.t.owner`update app.context_item_version set derived = null where item_id = ${mrr} and version = 3`;
    await checkDefinitions(s.deps, { orgId: s.orgId, connectionId: s.connectionId });
    expect(await release(mrr, 3)).toEqual({ ok: true, kind: "metric", connectionId: s.connectionId });
    expect(await item(mrr)).toMatchObject({ current_version: 3, released_version: 3, status: "verified" });
    // One never released (OpenDash's proposal, drafted to version 2): approved only at the version seen.
    expect(await release(churned, 1)).toMatchObject({ ok: false, reason: "conflict" });
    expect(await release(churned, 2)).toMatchObject({ ok: true, kind: "metric" });
    expect(await item(churned)).toMatchObject({ current_version: 2, released_version: 2, status: "verified" });
  });

  it("leaves a released metric's figures alone while a draft of its dataset is tested", async () => {
    await ask([{ kind: "dataset", id: mrrMonthly }], { threadId: thread });
    const before = await sampleOf(mrr, 3);
    expect(typeof before).toBe("number");
    const [v] = await s.t.owner<{ body: string }[]>`
      select body from app.context_item_version where item_id = ${mrrMonthly} and version = 1`;
    const doubled = String(v?.body).replace("round(sum(mrr_usd), 2)", "round(sum(mrr_usd) * 2, 2)");
    expect(doubled).not.toBe(v?.body);
    expect(
      await draft(s.userId, { kind: "dataset", name: "mrr_monthly", body: doubled, baseVersion: 1 }),
    ).toMatchObject({ ok: true, version: 2 });
    // Its tests, as the analyst's call runs them, then a sync's retest of everything.
    await checkDefinitions(s.deps, { orgId: s.orgId, connectionId: s.connectionId }, { only: [mrrMonthly] });
    expect(await sampleOf(mrr, 3)).toBe(before);
    await checkDefinitions(s.deps, { orgId: s.orgId, connectionId: s.connectionId }, { all: true });
    expect(await sampleOf(mrr, 3)).toBe(before);
    const [d] = await s.t.owner<{ status: string }[]>`
      select derived->>'status' as status from app.context_item_version where item_id = ${mrrMonthly} and version = 2`;
    expect(d?.status).toBe("passed");
  });
});

// Skills: saved and approved like guides, version by version; the run gets the released ones' names and
// "use it when" lines, and reads a released one's steps at its path in the knowledge folder. Never a draft,
// a deleted one, or another org's.
import { type TenantTx, uuidv7 } from "@opendash/db";
import { createOrg, freshDatabase, type TestDatabase, withTenantOn } from "@opendash/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AttachmentProblem,
  approveContext,
  ContextProblem,
  contextForRun,
  conversationAttachments,
  deleteContextItem,
  getContextItem,
  listContext,
  releasedFiles,
  SKILL_MAX,
  saveGuide,
  saveSkill,
  submitQuestion,
} from "../src";

let t: TestDatabase;
const orgId = uuidv7();
const otherOrg = uuidv7();
const connectionId = uuidv7();
const ctx = { orgId, userId: uuidv7() };
const tenant = <T>(fn: (tx: TenantTx) => Promise<T>, org = orgId) => withTenantOn(t.app, { orgId: org }, fn);
/** A released skill's steps as the run reads them, at its path: null for a draft, a deleted one or another org's. */
const readSkill = async (org: string, path = "/skills/board_pack_mrr_bridge/SKILL.md") =>
  (await tenant((tx) => releasedFiles(tx, org, connectionId, ["skill"]), org)).find((f) => f.path === path) ?? null;
const problem = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (error) {
    if (error instanceof ContextProblem) return error.message;
    throw error;
  }
};
const bridge = {
  title: "Board pack MRR bridge",
  description: "Asked for an MRR bridge",
  // A heading that repeats the name isn't the summary: the first step is.
  body: "# Board pack MRR bridge\n\n1. Opening MRR.",
};

beforeAll(async () => {
  t = await freshDatabase();
  await createOrg(t, orgId, "Skills");
  await createOrg(t, otherOrg, "Elsewhere");
  await t.owner`insert into app.connection (org_id, id, name, dialect) values (${orgId}, ${connectionId}, 'src', 'postgres')`;
});

afterAll(async () => {
  await t?.drop();
});

describe("skills", () => {
  it("are saved with a name, a one-line “use it when” and steps, and refuse what doesn't fit", async () => {
    expect(await problem(tenant((tx) => saveSkill(tx, ctx, { ...bridge, description: "" })))).toBe(
      "Say when the analyst should use it.",
    );
    expect(await problem(tenant((tx) => saveSkill(tx, ctx, { ...bridge, description: "x".repeat(301) })))).toMatch(
      /one line/,
    );
    expect(await problem(tenant((tx) => saveSkill(tx, ctx, { ...bridge, body: "  " })))).toBe(
      "Write the steps the analyst should follow.",
    );
    expect(await problem(tenant((tx) => saveSkill(tx, ctx, { ...bridge, body: "x".repeat(SKILL_MAX + 1) })))).toMatch(
      /under 100,000 characters/,
    );
    const saved = await tenant((tx) => saveSkill(tx, ctx, bridge));
    expect(saved.version).toBe(1);
    expect(await problem(tenant((tx) => saveSkill(tx, ctx, bridge)))).toBe("There's already a skill called that.");
    const [listed] = await tenant((tx) => listContext(tx, orgId, "skill"));
    expect(listed).toMatchObject({
      kind: "skill",
      title: bridge.title,
      summary: "1. Opening MRR.",
      useWhen: bridge.description,
      status: "draft",
    });
    const [row] = await t.owner<{ path: string }[]>`select path from app.context_item where id = ${saved.id}`;
    expect(row?.path).toBe("/skills/board_pack_mrr_bridge/SKILL.md");
  });

  it("can't take the name of OpenDash's own skills' folder", async () => {
    expect(
      await problem(tenant((tx) => saveSkill(tx, ctx, { title: "OpenDash", description: "Mine", body: "Steps." }))),
    ).toBe("That name is OpenDash's own: give the skill another.");
  });

  it("reach the run only once approved, at their path", async () => {
    const [item] = await tenant((tx) => listContext(tx, orgId, "skill"));
    const id = item?.id as string;
    expect((await tenant((tx) => contextForRun(tx, orgId, connectionId))).skills).toEqual([]);
    expect(await readSkill(orgId)).toBeNull();
    await tenant((tx) => approveContext(tx, ctx, [{ id, version: 1 }]));
    expect((await tenant((tx) => contextForRun(tx, orgId, connectionId))).skills).toEqual([
      {
        id,
        version: 1,
        title: bridge.title,
        description: bridge.description,
        path: "/skills/board_pack_mrr_bridge/SKILL.md",
      },
    ]);
    expect(await readSkill(orgId)).toMatchObject({ id, body: bridge.body });
    expect(await readSkill(orgId, "/skills/churn_deep_dive/SKILL.md")).toBeNull();
    // Another organization's run never reads it.
    expect(await readSkill(otherOrg)).toBeNull();
  });

  it("keep the released version answering while an edit waits, and stop at once when deleted", async () => {
    const [item] = await tenant((tx) => listContext(tx, orgId, "skill"));
    const id = item?.id as string;
    await tenant((tx) => saveSkill(tx, ctx, { ...bridge, id, body: "2. A new step." }));
    expect(await readSkill(orgId)).toMatchObject({ version: 1, body: bridge.body });
    expect((await tenant((tx) => getContextItem(tx, orgId, id)))?.released).toMatchObject({ version: 1 });
    await tenant((tx) => approveContext(tx, ctx, [{ id, version: 2 }]));
    expect(await readSkill(orgId)).toMatchObject({ version: 2 });
    expect(await tenant((tx) => deleteContextItem(tx, orgId, id))).toBe(true);
    expect(await readSkill(orgId)).toBeNull();
    expect((await tenant((tx) => contextForRun(tx, orgId, connectionId))).skills).toEqual([]);
  });
});

describe("choosing a skill for a question", () => {
  const deps = {
    withTenant: <T>(org: string, fn: (tx: TenantTx) => Promise<T>) => withTenantOn(t.app, { orgId: org }, fn),
    boss: null,
  };
  const member = uuidv7();
  const ask = (
    userId: string,
    text: string,
    attachments: { kind: "skill"; id: string; version?: number }[] = [],
    canTryDrafts = false,
    threadId?: string,
  ) =>
    submitQuestion(deps, {
      orgId,
      userId,
      connectionId,
      text,
      channel: "web",
      model: "m",
      attachments,
      canTryDrafts,
      ...(threadId ? { threadId } : {}),
    });
  const refused = async (p: Promise<unknown>) => {
    try {
      await p;
      return "ok";
    } catch (error) {
      if (error instanceof AttachmentProblem) return error.message;
      throw error;
    }
  };
  let id = "";

  beforeAll(async () => {
    ({ id } = await tenant((tx) =>
      saveSkill(tx, ctx, { ...bridge, title: "Churn deep dive", description: "Asked why churn moved" }),
    ));
    await tenant((tx) => approveContext(tx, ctx, [{ id, version: 1 }]));
    await tenant((tx) =>
      saveSkill(tx, ctx, {
        ...bridge,
        id,
        title: "Churn deep dive",
        description: "Asked why churn moved",
        body: "2. A draft step.",
      }),
    );
  });

  it("keeps the released version for anyone, and a draft only for owners and admins", async () => {
    const q = await ask(member, "Why did churn move?", [{ kind: "skill", id }]);
    const [m] = await t.owner<
      { attachments: unknown }[]
    >`select attachments from app.message where thread_id = ${q.threadId}`;
    expect(m?.attachments).toEqual([{ kind: "skill", id, version: 1 }]);
    expect(await refused(ask(member, "And the draft?", [{ kind: "skill", id, version: 2 }]))).toBe(
      "Only owners and admins try a skill before it's approved.",
    );
    expect(await refused(ask(ctx.userId, "A version that isn't?", [{ kind: "skill", id, version: 9 }], true))).toBe(
      "That version of the skill doesn't exist.",
    );
    expect(await ask(ctx.userId, "Trying the draft", [{ kind: "skill", id, version: 2 }], true)).toMatchObject({
      threadId: expect.any(String),
    });
  });

  it("gives a draft to the one who chose it, at that version, while they may still try drafts, and to nobody else", async () => {
    const q = await ask(ctx.userId, "Trying the draft again", [{ kind: "skill", id, version: 2 }], true);
    const given = (userId: string, canTryDrafts: boolean) =>
      tenant((tx) => conversationAttachments(tx, { orgId, userId }, q.threadId, connectionId, { canTryDrafts }));
    expect((await given(ctx.userId, true)).items).toEqual([
      { kind: "skill", id, title: "Churn deep dive", version: 2, body: "2. A draft step.", draft: true },
    ]);
    // The one who chose it, no longer an owner or admin when they ask again: not given.
    expect(await given(ctx.userId, false)).toEqual({ items: [], missing: 1 });
    expect(await given(member, true)).toEqual({ items: [], missing: 1 });
    // The run records whether its asker may: set from the caller when the question was asked.
    const [run] = await t.owner<
      { can_try_drafts: boolean }[]
    >`select can_try_drafts from app.run where id = ${q.runId}`;
    expect(run?.can_try_drafts).toBe(true);
  });

  it("keeps a version only on a skill", async () => {
    const guide = await tenant((tx) =>
      saveGuide(tx, ctx, { title: "Refund policy", body: "Refunds count against MRR." }),
    );
    await tenant((tx) => approveContext(tx, ctx, [{ id: guide.id, version: 1 }]));
    const q = await ask(member, "A guide with a version?", [
      { kind: "guide", id: guide.id, version: 7 } as unknown as { kind: "skill"; id: string; version?: number },
    ]);
    const [m] = await t.owner<
      { attachments: unknown }[]
    >`select attachments from app.message where thread_id = ${q.threadId}`;
    expect(m?.attachments).toEqual([{ kind: "guide", id: guide.id }]);
  });

  it("takes /skill:<name> as the question with that released skill attached", async () => {
    const q = await ask(member, "/skill:churn_deep_dive Why did churn rise in September?");
    const [m] = await t.owner<{ text: string; attachments: unknown }[]>`
      select text, attachments from app.message where thread_id = ${q.threadId}`;
    expect(m).toEqual({ text: "Why did churn rise in September?", attachments: [{ kind: "skill", id, version: 1 }] });
    const [thread] = await t.owner<{ title: string }[]>`select title from app.thread where id = ${q.threadId}`;
    expect(thread?.title).toBe("Why did churn rise in September?");
    expect(await refused(ask(member, "/skill:no_such_skill Why?"))).toBe(
      "There's no approved skill called no_such_skill.",
    );
    expect(await refused(ask(member, "/skill:churn_deep_dive"))).toBe(
      "Add your question after /skill:churn_deep_dive.",
    );
  });
});

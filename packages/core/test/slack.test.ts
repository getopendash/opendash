// Slack, without Slack: adding a workspace with its own token, Slack taking it back, who's asking
// (not connected, not linked, a member), links checked in an order that tells a stranger nothing and that work once,
// one Slack account per person, a question asked as the member who asked it with its file, follow-ups per person and
// Slack thread, the reply's record (taken up again when its run ends unfinished) and the stop button.
import { uuidv7 } from "@opendash/db";
import { createOrg, withPublicOn, withSystemOn } from "@opendash/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  askFromSlack,
  confirmSlackLink,
  connectSlack,
  disconnectSlack,
  finishSlackReply,
  mySlackIdentity,
  passOnFollowUps,
  purgeSlackLinks,
  type SlackQuestion,
  SlackTaken,
  slackAsker,
  slackAskOf,
  slackBotToken,
  slackIdentities,
  slackLinkPreview,
  slackRemovedBySlack,
  slackReplyOf,
  slackSuggestions,
  slackWorkspace,
  startSlackLink,
  stopSlackRun,
  suggestedQuestions,
  unlinkMySlack,
} from "../src";
import { type LearnedSource, learnedSource } from "./helpers/learned-source";

let s: LearnedSource;
const team = { teamId: "T0ACME", teamName: "Acme Corp", teamDomain: "acme", botUserId: "U0BOT" };
const keys = { anthropic: true, openai: false, google: false } as never;
let deps: Parameters<typeof slackAsker>[0] & { secrets: LearnedSource["secrets"] };

beforeAll(async () => {
  s = await learnedSource();
  deps = {
    withTenant: s.deps.withTenant,
    withPublic: (fn) => withPublicOn(s.t.app, fn),
    secrets: s.secrets,
  };
  // The asker is a member of the workspace (the app role can't write auth tables; the owner can).
  await s.t.owner`insert into auth.user (id, name, email, email_verified)
    values (${s.userId}, 'Priya Raman', 'priya@acme.test', true) on conflict (id) do update set name = excluded.name, email = excluded.email`;
  await s.t.owner`insert into auth.member (id, organization_id, user_id, role, created_at)
    values (${uuidv7()}, ${s.orgId}, ${s.userId}, 'member', now())
      on conflict (organization_id, user_id) do update set role = excluded.role`;
}, 300_000);

afterAll(async () => {
  await s?.close();
});

const question = (over: Partial<SlackQuestion> = {}): SlackQuestion => ({
  orgId: s.orgId,
  userId: s.userId,
  role: "member",
  teamId: team.teamId,
  slackThreadId: "slack:D0PRIYA:1791700000.000100",
  slackUserId: "UPRIYA",
  slackMessageId: uuidv7(),
  text: "How did MRR change last month?",
  files: [],
  ...over,
});
const ask = (q: SlackQuestion) =>
  askFromSlack({ withTenant: s.deps.withTenant, boss: s.boss, deploymentKeys: keys }, q);
const endRun = (runId: string) =>
  s.t.owner`update app.run set status = 'failed', error = 'test', finished_at = now() where id = ${runId}`;

describe("connecting a Slack workspace", () => {
  it("keeps its token encrypted, refuses a second workspace and a team connected elsewhere, and disconnects", async () => {
    await s.tenant((tx) => connectSlack(deps, tx, { orgId: s.orgId, userId: s.userId }, team, "xoxb-acme-secret"));
    const shown = await s.tenant((tx) => slackWorkspace(tx, s.orgId));
    expect(shown).toMatchObject({ teamId: "T0ACME", teamName: "Acme Corp", connectedBy: s.userId, removed: null });
    const [stored] = await s.t.owner<{ ciphertext: Buffer }[]>`
      select ciphertext from app.secret where org_id = ${s.orgId} and kind = 'oauth'`;
    expect(Buffer.from(stored?.ciphertext ?? []).toString("utf8")).not.toContain("xoxb-acme-secret");
    expect(await slackBotToken(deps, "T0ACME")).toEqual({
      orgId: s.orgId,
      botUserId: "U0BOT",
      token: "xoxb-acme-secret",
    });
    expect(await slackBotToken(deps, "T0OTHER")).toBeNull();

    const second = s.tenant((tx) =>
      connectSlack(deps, tx, { orgId: s.orgId, userId: s.userId }, { ...team, teamId: "T0BETA" }, "xoxb-beta"),
    );
    await expect(second).rejects.toThrow("Another Slack workspace is connected here. Disconnect it first.");
    await expect(second).rejects.toMatchObject({ where: "here" });
    const other = uuidv7();
    await createOrg(s.t, other, "Beta");
    const elsewhere = s.deps.withTenant(other, (tx) =>
      connectSlack(deps, tx, { orgId: other, userId: s.userId }, team, "xoxb-elsewhere"),
    );
    await expect(elsewhere).rejects.toBeInstanceOf(SlackTaken);
    await expect(elsewhere).rejects.toThrow("This Slack workspace is connected to another OpenDash workspace.");

    // Disconnecting hands the token back (to revoke at Slack) and takes the secret with it.
    expect(await s.tenant((tx) => disconnectSlack(deps, tx, s.orgId))).toEqual({
      disconnected: true,
      token: "xoxb-acme-secret",
      unreadable: false,
    });
    const [left] = await s.t.owner<{ n: number }[]>`
      select count(*)::int as n from app.secret where org_id = ${s.orgId} and kind = 'oauth'`;
    expect(left?.n).toBe(0);
    expect(await s.tenant((tx) => disconnectSlack(deps, tx, s.orgId))).toEqual({
      disconnected: false,
      token: null,
      unreadable: false,
    });
  });

  it("is taken back by Slack: removed, its token gone, open replies closed, and added again with Add to Slack", async () => {
    await s.tenant((tx) => connectSlack(deps, tx, { orgId: s.orgId, userId: s.userId }, team, "xoxb-first"));
    expect(await slackRemovedBySlack(deps, { teamId: "T0OTHER", why: "uninstalled" })).toBe(false);
    // An event from before this install (Slack retrying one sent while the socket was down) changes nothing.
    const before = Math.floor(Date.now() / 1000) - 3_600;
    expect(await slackRemovedBySlack(deps, { teamId: "T0ACME", why: "uninstalled", eventTime: before })).toBe(false);
    // A token revoked that isn't the bot OpenDash keeps there changes nothing either.
    expect(
      await slackRemovedBySlack(deps, { teamId: "T0ACME", why: "tokens_revoked", botUserIds: ["U0SOMEONEELSE"] }),
    ).toBe(false);
    expect((await slackBotToken(deps, "T0ACME"))?.token).toBe("xoxb-first");
    const now = Math.floor(Date.now() / 1000) + 5;
    expect(await slackRemovedBySlack(deps, { teamId: "T0ACME", why: "uninstalled", eventTime: now })).toBe(true);
    // Said twice by Slack (an event and a token revoked): once is enough.
    expect(await slackRemovedBySlack(deps, { teamId: "T0ACME", why: "tokens_revoked", botUserIds: ["U0BOT"] })).toBe(
      false,
    );
    const removed = await s.tenant((tx) => slackWorkspace(tx, s.orgId));
    expect(removed?.removed).toEqual({ at: expect.any(String), why: "uninstalled" });
    expect(await slackBotToken(deps, "T0ACME")).toBeNull();
    const [secrets] = await s.t.owner<{ n: number }[]>`
      select count(*)::int as n from app.secret where org_id = ${s.orgId} and kind = 'oauth'`;
    expect(secrets?.n).toBe(0);
    // Asking there now: nobody is answered (the team has no token), and the workspace still says it's this one's.
    expect(await slackAsker(deps, "T0ACME", "UPRIYA")).toEqual({ kind: "unlinked", orgId: s.orgId });

    await s.tenant((tx) => connectSlack(deps, tx, { orgId: s.orgId, userId: s.userId }, team, "xoxb-again"));
    expect((await s.tenant((tx) => slackWorkspace(tx, s.orgId)))?.removed).toBeNull();
    expect((await slackBotToken(deps, "T0ACME"))?.token).toBe("xoxb-again");
  });
});

describe("who's asking", () => {
  it("links a Slack user to the member who confirms, checking the email first, once, and only for a member", async () => {
    expect(await slackAsker(deps, "T0OTHER", "UPRIYA")).toEqual({ kind: "unconnected" });
    expect(await slackAsker(deps, "T0ACME", "UPRIYA")).toEqual({ kind: "unlinked", orgId: s.orgId });

    const priya = { orgId: s.orgId, userId: s.userId, email: "Priya@Acme.test", role: "member" };
    const token = await s.tenant((tx) =>
      startSlackLink(tx, s.orgId, "T0ACME", "UPRIYA", { name: "Priya Raman", email: "priya@acme.test" }),
    );
    // A stranger with a forwarded link learns only that it isn't theirs, whichever workspace they're in (its email is
    // checked first, partly shown).
    const stranger = { orgId: uuidv7(), userId: uuidv7(), email: "x@y.test", role: "owner" };
    expect(await slackLinkPreview(deps, token, stranger)).toEqual({ kind: "not_yours", shown: "p•••@acme.test" });
    expect(await confirmSlackLink(deps, stranger, token)).toEqual({ kind: "not_yours", shown: "p•••@acme.test" });
    const colleague = { orgId: s.orgId, userId: uuidv7(), email: "marcus@acme.test", role: "member" };
    expect(await confirmSlackLink(deps, colleague, token)).toEqual({ kind: "not_yours", shown: "p•••@acme.test" });
    // The person it was sent to, in another of their workspaces, or as a viewer here: told so, nothing linked.
    expect(await confirmSlackLink(deps, { ...priya, orgId: uuidv7() }, token)).toEqual({ kind: "other_workspace" });
    expect(await slackLinkPreview(deps, token, { ...priya, role: "viewer" })).toEqual({ kind: "viewer" });
    expect(await confirmSlackLink(deps, { ...priya, role: "viewer" }, token)).toEqual({ kind: "viewer" });
    // Then they link it, the email compared without case; it works once.
    expect(await slackLinkPreview(deps, token, priya)).toEqual({
      kind: "ok",
      orgId: s.orgId,
      teamName: "Acme Corp",
      slackUserName: "Priya Raman",
    });
    expect(await confirmSlackLink(deps, priya, token)).toEqual({ kind: "linked", teamName: "Acme Corp" });
    expect(await confirmSlackLink(deps, priya, token)).toEqual({ kind: "invalid" });
    expect(await confirmSlackLink(deps, priya, "not-a-token")).toEqual({ kind: "invalid" });
    // A Slack account whose email Slack didn't share can't be linked at all.
    const hidden = await s.tenant((tx) => startSlackLink(tx, s.orgId, "T0ACME", "UHIDDEN", { name: "Hidden" }));
    expect(await confirmSlackLink(deps, priya, hidden)).toEqual({ kind: "not_yours", shown: null });
    expect(await slackAsker(deps, "T0ACME", "UPRIYA")).toEqual({
      kind: "member",
      orgId: s.orgId,
      userId: s.userId,
      role: "member",
    });
    expect(await s.tenant((tx) => slackIdentities(tx, s.orgId))).toEqual([
      { slackUserId: "UPRIYA", slackUserName: "Priya Raman", userId: s.userId, linkedAt: expect.any(String) },
    ]);

    // Linked, they're offered questions from their own data when they open OpenDash in Slack; others get the app's.
    const offered = await slackSuggestions(deps, "T0ACME", "UPRIYA");
    expect(offered?.length).toBeGreaterThan(0);
    expect(offered).toEqual(await s.tenant((tx) => suggestedQuestions(tx, s.orgId, s.connectionId)));
    expect(await slackSuggestions(deps, "T0ACME", "UNOBODY")).toBeNull();
    expect(await slackSuggestions(deps, "T0OTHER", "UPRIYA")).toBeNull();
  });

  it("keeps one Slack account per person: linking another replaces it, and they can unlink themselves", async () => {
    const priya = { orgId: s.orgId, userId: s.userId, email: "priya@acme.test", role: "member" };
    const token = await s.tenant((tx) =>
      startSlackLink(tx, s.orgId, "T0ACME", "UPRIYA2", { name: "Priya (work)", email: "priya@acme.test" }),
    );
    expect(await confirmSlackLink(deps, priya, token)).toEqual({ kind: "linked", teamName: "Acme Corp" });
    expect((await s.tenant((tx) => slackIdentities(tx, s.orgId))).map((p) => p.slackUserId)).toEqual(["UPRIYA2"]);
    expect(await s.tenant((tx) => mySlackIdentity(tx, s.orgId, s.userId))).toMatchObject({
      slackUserId: "UPRIYA2",
      slackUserName: "Priya (work)",
      teamName: "Acme Corp",
    });
    expect(await s.tenant((tx) => unlinkMySlack(tx, s.orgId, s.userId))).toBe(true);
    expect(await s.tenant((tx) => mySlackIdentity(tx, s.orgId, s.userId))).toBeNull();
    expect(await slackAsker(deps, "T0ACME", "UPRIYA2")).toEqual({ kind: "unlinked", orgId: s.orgId });
  });

  it("unlinks someone removed from the workspace at once", async () => {
    const former = uuidv7();
    await s.t
      .owner`insert into auth.user (id, name, email, email_verified) values (${former}, 'Former', 'former@acme.test', true)`;
    await s.t.owner`insert into auth.member (id, organization_id, user_id, role, created_at)
      values (${uuidv7()}, ${s.orgId}, ${former}, 'member', now())`;
    await s.t.owner`insert into app.slack_identity (org_id, team_id, slack_user_id, user_id)
      values (${s.orgId}, 'T0ACME', 'UFORMER', ${former})`;
    expect(await slackAsker(deps, "T0ACME", "UFORMER")).toMatchObject({ kind: "member", userId: former });
    await s.t.owner`delete from auth.member where organization_id = ${s.orgId} and user_id = ${former}`;
    expect(await slackAsker(deps, "T0ACME", "UFORMER")).toEqual({ kind: "unlinked", orgId: s.orgId });
    const [kept] = await s.t.owner<{ n: number }[]>`
      select count(*)::int as n from app.slack_identity where slack_user_id = 'UFORMER'`;
    expect(kept?.n).toBe(0);
  });

  it("purges links once used, or a day after they expired", async () => {
    const fresh = await s.tenant((tx) => startSlackLink(tx, s.orgId, "T0ACME", "UFRESH", { email: "a@acme.test" }));
    await s.t.owner`update app.slack_link set expires_at = now() - interval '2 days' where slack_user_id = 'UHIDDEN'`;
    const purged = await purgeSlackLinks((fn) => withSystemOn(s.t.system, fn));
    expect(purged).toBeGreaterThanOrEqual(3);
    const left = await s.t.owner<{ slack_user_id: string }[]>`select slack_user_id from app.slack_link`;
    expect(left.map((r) => r.slack_user_id)).toEqual(["UFRESH"]);
    expect(fresh).toMatch(/^[A-Za-z0-9_-]{20,64}$/);
  });
});

describe("asking from Slack", () => {
  it("asks as the member, with their file, and queues the reply with ids only", async () => {
    const file = { name: "q3-targets.md", text: "MRR target: $400,000" };
    const asked = await ask(question({ files: [file], slackMessageId: "1791700001.000200" }));
    expect(asked.kind).toBe("asked");
    if (asked.kind !== "asked") return;
    const [thread] = await s.t.owner<{ channel: string; created_by: string }[]>`
      select channel, created_by from app.thread where id = ${asked.threadId}`;
    expect(thread).toEqual({ channel: "slack", created_by: s.userId });
    const [message] = await s.t.owner<{ attachments: { kind: string; name: string; text: string }[] }[]>`
      select m.attachments from app.message m join app.run r on r.input_message_id = m.id where r.id = ${asked.runId}`;
    expect(message?.attachments).toEqual([expect.objectContaining({ kind: "file", ...file })]);
    const [job] = await s.t.owner<{ data: Record<string, unknown> }[]>`
      select data from pgboss.job where name = 'slack.reply' and data->>'runId' = ${asked.runId}`;
    expect(job?.data).toEqual({ orgId: s.orgId, runId: asked.runId });
    expect(await s.tenant((tx) => slackReplyOf(tx, s.orgId, asked.runId))).toEqual({
      teamId: "T0ACME",
      slackThreadId: "slack:D0PRIYA:1791700000.000100",
      slackUserId: "UPRIYA",
      slackMessageTs: "1791700001.000200",
      status: "streaming",
      userId: s.userId,
      // Only Priya's conversation is in that Slack thread.
      shared: false,
      // Asked here without linking her Slack account first (the bot links before it asks): no reply would post.
      linked: false,
    });

    // While it runs, another question in the same thread joins it; the stop button stops it, and what was
    // added is the next question, replied to in the same Slack thread.
    expect(await ask(question({ text: "And churn?" }))).toEqual({
      kind: "queued",
      runId: asked.runId,
      threadId: asked.threadId,
    });
    expect(
      await stopSlackRun(
        { ...s.deps, boss: s.boss },
        { orgId: s.orgId, userId: s.userId },
        "T0ACME",
        "slack:D0PRIYA:1791700000.000100",
        "UPRIYA",
      ),
    ).toBe(true);
    const [next] = await s.t.owner<{ id: string }[]>`
      select r.id from app.run r join app.message m on m.id = r.input_message_id
      where r.thread_id = ${asked.threadId} and m.text = 'And churn?'`;
    expect(await s.tenant((tx) => slackReplyOf(tx, s.orgId, next?.id as string))).toMatchObject({
      slackThreadId: "slack:D0PRIYA:1791700000.000100",
      slackMessageTs: null,
    });
    const [nextJob] = await s.t.owner<{ n: number }[]>`
      select count(*)::int as n from pgboss.job where name = 'slack.reply' and data->>'runId' = ${next?.id as string}`;
    expect(nextJob?.n).toBe(1);
    await endRun(next?.id as string);

    // A follow-up in the same Slack thread continues the conversation; someone else there starts their own.
    const followUp = await ask(question({ text: "And by plan?" }));
    expect(followUp).toMatchObject({ kind: "asked", threadId: asked.threadId });
    if (followUp.kind === "asked") await endRun(followUp.runId);
    const other = uuidv7();
    const theirs = await ask(question({ userId: other, slackUserId: "UMARCUS", text: "Which plan churned most?" }));
    expect(theirs.kind === "asked" && theirs.threadId).not.toBe(asked.threadId);
    if (theirs.kind === "asked") await endRun(theirs.runId);

    await s.tenant((tx) => finishSlackReply(tx, s.orgId, asked.runId, "done"));
    expect((await s.tenant((tx) => slackReplyOf(tx, s.orgId, asked.runId)))?.status).toBe("done");
  });

  it("finds a run's questions for a Send press: who asked them, and whether they're still the latest ask", async () => {
    const asked = await ask(question({ slackThreadId: "slack:D0PRIYA:1791700000.000400" }));
    if (asked.kind !== "asked") throw new Error(asked.kind);
    const questions = [
      { question: "Which measure?", options: ["Signups", "Accounts"], multiple: true },
      { question: "Which window?", options: ["Last year", "Last 3 months"] },
    ];
    await s.t.owner`update app.run set status = 'succeeded', finished_at = now(),
      outcome = ${s.t.owner.json({ kind: "clarify", questions })} where id = ${asked.runId}`;
    expect(await s.tenant((tx) => slackAskOf(tx, s.orgId, asked.runId))).toEqual({
      questions,
      slackUserId: "UPRIYA",
      latest: true,
    });
    // Answered in their own words meanwhile: an old ask now. A run that didn't ask anything isn't one.
    const typed = await ask(question({ slackThreadId: "slack:D0PRIYA:1791700000.000400", text: "Signups, last year" }));
    expect((await s.tenant((tx) => slackAskOf(tx, s.orgId, asked.runId)))?.latest).toBe(false);
    if (typed.kind === "asked") {
      expect(await s.tenant((tx) => slackAskOf(tx, s.orgId, typed.runId))).toBeNull();
      await endRun(typed.runId);
    }
    expect(await s.tenant((tx) => slackAskOf(tx, s.orgId, "not-a-run"))).toBeNull();
  });

  it("refuses a viewer, and asks which source when there are several", async () => {
    expect(await ask(question({ role: "viewer", slackThreadId: "slack:D0PRIYA:1791700000.000200" }))).toEqual({
      kind: "refused",
      message: "Viewers read shared conversations. Ask an admin for the Member role to ask.",
    });
    const second = uuidv7();
    await s.t.owner`insert into app.connection (org_id, id, name, dialect, status)
      values (${s.orgId}, ${second}, 'Warehouse', 'postgres', 'ok')`;
    // Learned once: a succeeded sync.
    await s.t.owner`insert into app.sync_run (org_id, id, connection_id, status, steps, finished_at)
      values (${s.orgId}, ${uuidv7()}, ${second}, 'succeeded', '[]', now())`;
    const choose = await ask(question({ slackThreadId: "slack:C0REV:1791700000.000300" }));
    expect(choose.kind).toBe("choose_source");
    if (choose.kind !== "choose_source") return;
    expect(choose.sources.map((x) => x.name)).toContain("Warehouse");
    await s.t.owner`delete from app.connection where id = ${second}`;
  });
});

describe("a reply left unfinished", () => {
  it("is queued again when its run ends, unless a job has it already or it's finished", async () => {
    const asked = await ask(question({ slackThreadId: `slack:C0RE:${uuidv7()}` }));
    if (asked.kind !== "asked") throw new Error(asked.kind);
    const queued = async () => {
      const [r] = await s.t.owner<{ n: number }[]>`
        select count(*)::int as n from pgboss.job
        where name = 'slack.reply' and singleton_key = ${asked.runId} and state in ('created', 'retry', 'active')`;
      return r?.n ?? 0;
    };
    // Asking queued its reply; the run ending while that job has it adds nothing.
    expect(await queued()).toBe(1);
    await s.tenant((tx) => passOnFollowUps(tx, s.boss, { orgId: s.orgId, id: asked.runId }));
    expect(await queued()).toBe(1);
    // The job stopped (given up on, or cut off) with the reply unfinished: the run's end takes it up again.
    await s.t
      .owner`update pgboss.job set state = 'failed' where name = 'slack.reply' and singleton_key = ${asked.runId}`;
    await s.tenant((tx) => passOnFollowUps(tx, s.boss, { orgId: s.orgId, id: asked.runId }));
    expect(await queued()).toBe(1);
    // Finished: nothing more.
    await s.t
      .owner`update pgboss.job set state = 'completed' where name = 'slack.reply' and singleton_key = ${asked.runId}`;
    await s.tenant((tx) => finishSlackReply(tx, s.orgId, asked.runId, "done"));
    await s.tenant((tx) => passOnFollowUps(tx, s.boss, { orgId: s.orgId, id: asked.runId }));
    expect(await queued()).toBe(0);
  });
});

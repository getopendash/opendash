// Telling what checks find: a metric watched by several routines is read once and each finding filed once;
// each routine whose condition it meets tells its own people once, at its own sensitivity, at once or in the day's
// roundup, after an investigation when it asks for one. A line crossed is told once, and again only after the metric
// comes back. Nothing here involves a model: the Investigator's run is ended by hand.
import { uuidv7 } from "@opendash/db";
import { withSystemOn } from "@opendash/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  composerChoices,
  connectSlack,
  createRoutine,
  type DeliveryOut,
  deliverEffect,
  type FoundSpec,
  failRun,
  getRoutine,
  listInsights,
  openInsightCount,
  type RoutineMessage,
  reconcileChecks,
  releaseDueRuns,
  runRoutineRun,
  setSpendLimits,
  settleInvestigation,
  watchedByRoutines,
} from "../src";
import { actor, check, checkOf, jobDeps, member, verifiedSource } from "./helpers/checks";
import type { LearnedSource } from "./helpers/learned-source";

let s: LearnedSource;
let ids: Record<string, string> = {};
const NOW = new Date("2026-10-11T09:00:00Z");
const bob = uuidv7();
const id = (slug: string) => ids[slug] as string;
const messages: RoutineMessage[] = [];
const out: DeliveryOut = {
  sender: { send: async () => ({ id: `email-${messages.length}` }) },
  render: (m) => {
    messages.push(m);
    return { subject: m.kind, html: "", text: "" };
  },
  baseUrl: "https://app.opendash.example",
  canDeliver: () => true,
};
const found = (condition: FoundSpec["condition"], extra: Partial<FoundSpec> = {}): FoundSpec => ({
  version: 1,
  trigger: "found",
  metricIds: [id("new_accounts")],
  condition,
  tell: "at_once",
  investigate: false,
  ...extra,
});
const make = (spec: FoundSpec, userIds: string[]) =>
  s.tenant((tx) => createRoutine(tx, actor(s), { spec, userIds }, NOW));
const runsOf = (routineId: string) =>
  s.t.owner<{ id: string; trigger_key: string; status: string; insight_ids: string[]; due_at: Date | null }[]>`
    select id, trigger_key, status, insight_ids, due_at from app.routine_run
    where org_id = ${s.orgId} and routine_id = ${routineId} order by created_at`;
const sendAll = async () => {
  const rows = await s.t.owner<{ id: string }[]>`
    select id from app.effect where org_id = ${s.orgId} and status = 'queued' order by created_at`;
  for (const e of rows) await deliverEffect({ ...s.deps, boss: s.boss }, { orgId: s.orgId, effectId: e.id }, out);
};
/** A fresh start for the next case: no findings, runs or sends yet, and the given routines only. */
const reset = async (keep: string[] = []) => {
  await s.t.owner`delete from app.insight where org_id = ${s.orgId}`;
  await s.t.owner`delete from app.effect where org_id = ${s.orgId}`;
  await s.t.owner`delete from app.routine_run where org_id = ${s.orgId}`;
  await s.t.owner`update app.routine set deleted_at = now()
    where org_id = ${s.orgId} and key is null and not (id = any(${`{${keep.join(",")}}`}::uuid[]))`;
  messages.length = 0;
};
const monthly = () => check(s, id("new_accounts"), "month", NOW);

beforeAll(async () => {
  ({ s, ids } = await verifiedSource(NOW));
  await member(s, s.userId, "maya@acme.example", "owner");
  await member(s, bob, "bob@acme.example");
}, 300_000);

afterAll(async () => {
  await s?.close();
});

describe("routines that watch", () => {
  it("read a metric once, file what's found once, and tell each routine's people once, at its own band", async () => {
    const higher = await make(found({ kind: "unusual", sensitivity: "higher" }), [s.userId]);
    const lower = await make(found({ kind: "unusual", sensitivity: "lower" }), [bob]);
    const line = await make(found({ kind: "crosses", direction: "above", value: 1_000_000 }), [bob]);
    const elsewhere = await make(
      found({ kind: "unusual", sensitivity: "higher" }, { metricIds: [id("churned_mrr")] }),
      [bob],
    );
    const monthCheck = (await checkOf(s, id("new_accounts"), "month")) as string;
    const queries = async () =>
      (
        await s.t.owner<{ n: number }[]>`
          select count(*)::int as n from app.query_run where org_id = ${s.orgId} and requester_type = 'check'
            and requester_id = ${monthCheck}`
      )[0]?.n;
    const before = await queries();
    const result = await monthly();
    expect(await queries()).toBe((before ?? 0) + 1);
    // September's dip, filed once for the workspace, at the band of the routines that reach others (Lower, k 4): a
    // private routine's own sensitivity never shapes the shared feed. Maya's Higher one, hers alone, is told it too.
    const [insight] = await s.t.owner<{ id: string; owner_id: string | null; claims: { expected: { k: number } } }[]>`
      select id, owner_id, claims from app.insight where org_id = ${s.orgId} and kind = 'anomaly'`;
    expect(result.filed).toEqual([insight?.id]);
    expect(insight?.owner_id).toBeNull();
    expect(insight?.claims.expected.k).toBe(4);
    expect(result.runs).toBe(2);
    expect((await runsOf(higher)).map((r) => [r.trigger_key, r.status])).toEqual([[`found:${insight?.id}`, "queued"]]);
    expect((await runsOf(lower)).map((r) => r.insight_ids)).toEqual([[insight?.id]]);
    expect(await runsOf(line)).toEqual([]);
    expect(await runsOf(elsewhere)).toEqual([]);
    // Checked again: found again, filed nothing, told nobody.
    expect(await monthly()).toMatchObject({ filed: [], runs: 0 });
    expect(await runsOf(higher)).toHaveLength(1);
    // Each run tells its own people, each at its routine's own band.
    for (const r of [...(await runsOf(higher)), ...(await runsOf(lower))]) {
      await runRoutineRun(jobDeps(s), { orgId: s.orgId, routineRunId: r.id }, NOW);
    }
    await sendAll();
    const told = messages.map((m) => (m.kind === "findings" ? m.findings.findings[0]?.detail : null));
    expect(told).toHaveLength(2);
    // Higher's band (k 2) is half as wide as Lower's (k 4), around the same centre.
    expect(told).toEqual(["77 · usually 85–93", "77 · usually 82–96"]);
    expect((await runsOf(higher))[0]?.status).toBe("delivered");
    expect(messages.every((m) => m.because.startsWith("When New accounts is unusual, tell"))).toBe(true);
  });

  it("gather a day's findings in the roundup, sent at 07:00 where the workspace is", async () => {
    const roundup = await make(found({ kind: "unusual", sensitivity: "medium" }, { tell: "roundup" }), [s.userId]);
    await reset([roundup]);
    await monthly();
    const [waiting] = await runsOf(roundup);
    expect(waiting).toMatchObject({ trigger_key: "roundup:2026-10-12", status: "waiting" });
    expect(waiting?.due_at?.toISOString()).toBe("2026-10-12T07:00:00.000Z");
    // Another finding the same day joins it.
    await s.t.owner`delete from app.insight where org_id = ${s.orgId}`;
    await monthly();
    expect((await runsOf(roundup)).map((r) => r.insight_ids.length)).toEqual([2]);
    const release = (now: Date) =>
      releaseDueRuns(
        { withSystem: (fn) => withSystemOn(s.t.system, fn), withTenant: s.deps.withTenant, boss: s.boss },
        now,
      );
    expect(await release(new Date("2026-10-12T06:59:00Z"))).toBe(0);
    expect(await release(new Date("2026-10-12T07:00:00Z"))).toBe(1);
    expect(await release(new Date("2026-10-12T07:01:00Z"))).toBe(0);
    await runRoutineRun(jobDeps(s), { orgId: s.orgId, routineRunId: waiting?.id as string }, NOW);
    await sendAll();
    // Only the open one is told: the first was deleted (as good as gone) before it went.
    expect(messages.map((m) => m.kind === "findings" && m.findings.roundup)).toEqual([true]);
    // A busy day: every finding it gathered is told, not the first 50.
    const many = Array.from({ length: 60 }, () => uuidv7());
    for (const [i, id] of many.entries()) {
      await s.t
        .owner`insert into app.insight (org_id, id, connection_id, kind, period, title, summary, severity, dedupe_key)
        values (${s.orgId}, ${id}, ${s.connectionId}, 'anomaly', '2026-09-01', ${`Finding ${i}`}, 'Unusual.', 1,
          ${`test:busy:${i}`})`;
    }
    expect(await s.tenant((tx) => listInsights(tx, { orgId: s.orgId, userId: null }, { ids: many }))).toHaveLength(60);
    await s.t.owner`delete from app.insight where org_id = ${s.orgId} and starts_with(dedupe_key, 'test:busy:')`;
  });

  it("wait for an investigation when asked to, at most so long, and not at all when it's held", async () => {
    const careful = await make(found({ kind: "unusual", sensitivity: "medium" }, { investigate: true }), [s.userId]);
    await reset([careful]);
    await monthly();
    const [waiting] = await runsOf(careful);
    expect(waiting?.status).toBe("waiting");
    const [inv] = await s.t.owner<{ run_id: string; status: string }[]>`
      select run_id, status from app.investigation where org_id = ${s.orgId}`;
    expect(inv?.status).toBe("queued");
    // Its investigation ends: the run goes, with the verdict beside the finding.
    await s.t.owner`update app.run set status = 'succeeded', finished_at = now(),
      outcome = ${s.t.owner.json({ kind: "investigation", confirmed: true } as never)} where id = ${inv?.run_id as string}`;
    expect(await settleInvestigation({ ...s.deps, boss: s.boss }, s.orgId, inv?.run_id as string)).toBe("confirmed");
    expect((await runsOf(careful))[0]?.status).toBe("queued");
    await runRoutineRun(jobDeps(s), { orgId: s.orgId, routineRunId: waiting?.id as string }, NOW);
    await sendAll();
    expect(messages[0]?.kind === "findings" && messages[0].findings.findings[0]?.verdict).toBe(
      "Its investigation confirmed it.",
    );
    // An investigation that's overdue: the run goes without it.
    await reset([careful]);
    await monthly();
    const [late] = await runsOf(careful);
    const release = (now: Date) =>
      releaseDueRuns(
        { withSystem: (fn) => withSystemOn(s.t.system, fn), withTenant: s.deps.withTenant, boss: s.boss },
        now,
      );
    expect(await release(new Date(NOW.getTime() + 29 * 60_000))).toBe(0);
    expect(await release(new Date(NOW.getTime() + 31 * 60_000))).toBe(1);
    expect((await runsOf(careful)).find((r) => r.id === late?.id)?.status).toBe("queued");
    // Background work's budget off: held, so it isn't waited for.
    await reset([careful]);
    await s.t.owner`delete from app.investigation where org_id = ${s.orgId}`;
    const limits = (backgroundMonthlyUsd: number) =>
      s.tenant((tx) =>
        setSpendLimits(
          tx,
          { orgId: s.orgId, userId: s.userId },
          { monthlyUsd: null, dailyUsd: null, backgroundMonthlyUsd },
        ),
      );
    await limits(0);
    await monthly();
    expect((await runsOf(careful))[0]?.status).toBe("queued");
    await limits(10);
    // A member's, then they're made a viewer: told at once, with nothing investigated, and it stays on.
    const bobs = await s.tenant((tx) =>
      createRoutine(
        tx,
        actor(s, bob, false),
        { spec: found({ kind: "unusual", sensitivity: "medium" }, { investigate: true }), userIds: [bob] },
        NOW,
      ),
    );
    await reset([bobs]);
    await s.t.owner`delete from app.investigation where org_id = ${s.orgId}`;
    await s.t.owner`update auth.member set role = 'viewer' where organization_id = ${s.orgId} and user_id = ${bob}`;
    try {
      await monthly();
      const [told] = await runsOf(bobs);
      expect(told?.status).toBe("queued");
      expect(await s.t.owner`select 1 from app.investigation where org_id = ${s.orgId}`).toHaveLength(0);
      expect(await runRoutineRun(jobDeps(s), { orgId: s.orgId, routineRunId: told?.id as string }, NOW)).toBe(
        "sending",
      );
      expect(
        (await s.t.owner<{ status: string }[]>`select status from app.routine where id = ${bobs}`)[0]?.status,
      ).toBe("active");
    } finally {
      await s.t.owner`update auth.member set role = 'member' where organization_id = ${s.orgId} and user_id = ${bob}`;
    }
  });

  it("tell a line crossed once, and again only after the metric came back over it", async () => {
    await reset();
    // Three weeks in a row: under, over, under some line between them.
    await check(s, id("new_accounts"), "week", NOW);
    const obs = await s.t.owner<{ period_start: string; value: number }[]>`
      select period_start::text, value from app.observation
      where check_id = ${(await checkOf(s, id("new_accounts"), "week")) as string} order by period_start`;
    let triple: { weeks: string[]; line: number } | null = null;
    for (let i = obs.length - 1; i >= 2 && !triple; i--) {
      const [a, b, c] = [obs[i - 2], obs[i - 1], obs[i]] as { period_start: string; value: number }[];
      if ((b?.value ?? 0) > Math.max(a?.value ?? 0, c?.value ?? 0) + 1) {
        triple = {
          weeks: [a, b, c].map((x) => x?.period_start as string),
          line: (Math.max(a?.value ?? 0, c?.value ?? 0) + (b?.value ?? 0)) / 2,
        };
      }
    }
    expect(triple).not.toBeNull();
    const t = triple as { weeks: string[]; line: number };
    const crossing = await make(found({ kind: "crosses", direction: "below", value: t.line }), [s.userId]);
    // A day into the week after each one: that week is the last whole one.
    const after = (week: string) => new Date(Date.parse(`${week}T12:00:00Z`) + 8 * 86_400_000);
    const at = (week: string) => check(s, id("new_accounts"), "week", after(week));
    const first = await at(t.weeks[0] as string);
    expect(first.filed).toHaveLength(1);
    expect(await runsOf(crossing)).toHaveLength(1);
    // Over the line: it resolves, and nothing is told.
    expect((await at(t.weeks[1] as string)).filed).toEqual([]);
    const [resolved] = await s.t.owner<{ status: string }[]>`
      select status from app.insight where id = ${first.filed[0] as string}`;
    expect(resolved?.status).toBe("resolved");
    // Under again: a new crossing, told again.
    const again = await at(t.weeks[2] as string);
    expect(again.filed).toHaveLength(1);
    expect(again.filed[0]).not.toBe(first.filed[0]);
    expect((await runsOf(crossing)).map((r) => r.trigger_key)).toEqual([
      `found:${first.filed[0]}`,
      `found:${again.filed[0]}`,
    ]);
    // Checked again the same week: nothing new.
    expect((await at(t.weeks[2] as string)).filed).toEqual([]);
  });

  it("are read back for their screens: the metrics they watch, their checks, the findings each run told", async () => {
    await reset();
    const mine = await make(found({ kind: "unusual", sensitivity: "medium" }), [s.userId]);
    const bobs = await s.tenant((tx) =>
      createRoutine(tx, actor(s, bob, false), { spec: found({ kind: "missing" }), userIds: [bob] }, NOW),
    );
    await monthly();
    // Watching lists the metric with both routines, naming only those the viewer may see.
    const asMaya = await s.tenant((tx) => watchedByRoutines(tx, actor(s, s.userId, false)));
    const row = asMaya.find((r) => r.metric.id === id("new_accounts"));
    expect(row?.watchers.map((w) => w.id)).toEqual([mine]);
    expect(row?.others).toBe(1);
    expect(row?.grain).toBe("week");
    // An owner sees the same: Bob's routine tells only him, so it's his alone, counted but not named.
    const asOwner = (await s.tenant((tx) => watchedByRoutines(tx, actor(s)))).find(
      (r) => r.metric.id === id("new_accounts"),
    );
    expect(asOwner?.watchers.map((w) => w.id)).toEqual([mine]);
    expect(asOwner?.others).toBe(1);
    // Its page: the finding its run told, by title, and its metric's checks.
    const page = await s.tenant((tx) => getRoutine(tx, actor(s), mine));
    expect(page?.runs[0]?.insights.map((i) => i.title)).toEqual([
      "New accounts fell more than usual in September 2026",
    ]);
    expect(page?.checks.map((c) => [c.metric.title, c.grain])).toEqual([["New accounts", "week"]]);
    // The composer: how each metric is checked, how many routines watch it, its latest checked value.
    const choices = await s.tenant((tx) => composerChoices(tx, actor(s)));
    const accounts = choices.metrics.find((m) => m.id === id("new_accounts"));
    expect(accounts).toMatchObject({ grain: "week", watchedBy: 2 });
    expect(choices.sources.map((c) => c.id)).toContain(s.connectionId);
    expect(accounts?.points.length).toBeGreaterThan(0);
    expect(accounts?.points.at(-1)?.period).toBe(accounts?.latest?.period);
    await s.t.owner`update app.routine set deleted_at = now() where id = any(${[mine, bobs]})`;
  });

  it("tell a Slack channel what they found, in a post of its own beside each email", async () => {
    await reset();
    await s.tenant((tx) =>
      connectSlack(
        { secrets: s.secrets },
        tx,
        { orgId: s.orgId, userId: s.userId },
        { teamId: "T0TELLING", teamName: "Acme", teamDomain: "acme", botUserId: "U0OPENDASH" },
        "xoxb-test",
      ),
    );
    const growth = { teamId: "T0TELLING", channelId: "C0GROWTH01", name: "growth" };
    const routine = await s.tenant((tx) =>
      createRoutine(
        tx,
        actor(s),
        { spec: found({ kind: "unusual", sensitivity: "medium" }), userIds: [s.userId], slack: [growth] },
        NOW,
      ),
    );
    await monthly();
    const [run] = await runsOf(routine);
    await runRoutineRun(jobDeps(s), { orgId: s.orgId, routineRunId: run?.id as string }, NOW);
    const rows = await s.t.owner<{ channel: string; recipient_key: string; payload: { kind: string } }[]>`
      select channel, recipient_key, payload from app.effect where org_id = ${s.orgId} and source_id = ${run?.id as string}
      order by channel`;
    expect(rows.map((r) => [r.channel, r.recipient_key, r.payload.kind])).toEqual([
      ["email", `user:${s.userId}`, "alert"],
      ["slack", "slack:T0TELLING:C0GROWTH01", "alert"],
    ]);
  });
  it("file a line only a private routine draws as its owner's alone, and one the team's draws for everyone", async () => {
    // A placeholder line makes the week check, whose latest week sets a line it's under.
    const placeholder = await make(found({ kind: "crosses", direction: "below", value: 0 }), [s.userId]);
    await reset([placeholder]);
    await check(s, id("new_accounts"), "week", NOW);
    const [last] = await s.t.owner<{ value: number }[]>`
      select value from app.observation
      where check_id = ${(await checkOf(s, id("new_accounts"), "week")) as string} order by period_start desc limit 1`;
    const line = { direction: "below" as const, value: Number(last?.value) + 1 };
    const hers = await make(found({ kind: "crosses", ...line }), [s.userId]);
    await reset([hers]);
    await check(s, id("new_accounts"), "week", NOW);
    const open = () =>
      s.t.owner<{ id: string; owner_id: string | null; dedupe_key: string }[]>`
        select id, owner_id, dedupe_key from app.insight
        where org_id = ${s.orgId} and kind = 'threshold' and status in ('new', 'seen')`;
    const [mine] = await open();
    expect(mine).toMatchObject({ owner_id: s.userId });
    expect(mine?.dedupe_key.startsWith(`private:${s.userId}:threshold:`)).toBe(true);
    // Hers alone: nobody else, nor a channel, sees it; she does, marked as hers, and her routine tells her.
    const seen = (userId: string | null) =>
      s.tenant((tx) => listInsights(tx, { orgId: s.orgId, userId }, { ids: [mine?.id as string] }));
    expect(await seen(bob)).toEqual([]);
    expect(await seen(null)).toEqual([]);
    expect((await seen(s.userId)).map((i) => i.mine)).toEqual([true]);
    expect((await runsOf(hers)).map((r) => r.insight_ids)).toEqual([[mine?.id]]);
    // The same line drawn by a routine that reaches Bob too: the workspace's.
    const ours = await make(found({ kind: "crosses", ...line }), [s.userId, bob]);
    await reset([hers, ours]);
    await check(s, id("new_accounts"), "week", NOW);
    expect((await open()).map((i) => i.owner_id)).toEqual([null]);
  });

  it("file what only an owner's own routines watch for as theirs, at their own sensitivity", async () => {
    const hers = await make(found({ kind: "unusual", sensitivity: "higher" }), [s.userId]);
    await reset([hers]);
    await monthly();
    const found_ = await s.t.owner<
      { owner_id: string | null; dedupe_key: string; claims: { expected?: { k: number } } }[]
    >`
      select owner_id, dedupe_key, claims from app.insight where org_id = ${s.orgId} and kind in ('anomaly', 'trend')`;
    expect(found_.length).toBeGreaterThan(0);
    expect(found_.every((f) => f.owner_id === s.userId && f.dedupe_key.startsWith(`private:${s.userId}:`))).toBe(true);
    expect(found_.find((f) => f.claims.expected)?.claims.expected?.k).toBe(2);
    expect(await s.tenant((tx) => openInsightCount(tx, { orgId: s.orgId, userId: bob }))).toBe(0);
  });

  it("stop reading a metric once they pause themselves, after four failures in a row", async () => {
    const alone = await make(found({ kind: "unusual", sensitivity: "medium" }), [s.userId]);
    await reset([alone]);
    await s.tenant((tx) => reconcileChecks(tx, s.orgId, NOW));
    expect(await checkOf(s, id("new_accounts"), "month")).not.toBeNull();
    for (let i = 0; i < 4; i++) {
      const runId = uuidv7();
      await s.t.owner`insert into app.routine_run (org_id, id, routine_id, trigger_key, status)
        values (${s.orgId}, ${runId}, ${alone}, ${`manual:test-${i}`}, 'running')`;
      await s.tenant((tx) => failRun(tx, s.boss, s.orgId, runId, "Its source didn't answer."));
    }
    expect((await s.t.owner<{ status: string }[]>`select status from app.routine where id = ${alone}`)[0]?.status).toBe(
      "paused",
    );
    expect(await checkOf(s, id("new_accounts"), "month")).toBeNull();
    await s.t.owner`delete from app.effect where org_id = ${s.orgId}`;
  });
});

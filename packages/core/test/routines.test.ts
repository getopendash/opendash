// Scheduled routines: made by anyone for themselves, by owners and admins for others; dispatched once per
// due time where the workspace is (a late dispatcher runs only the latest); what OpenDash found, or a question answered
// by the Analyst in a conversation as wide as the routine reaches, handed to the outbox and sent to each person only
// while they're still on it and can still read it. Four failed runs pause a routine and tell its owner.
// Nothing here calls a model: the Analyst's runs are ended by hand.
import { uuidv7 } from "@opendash/db";
import { createOrg, withSystemOn } from "@opendash/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adoptOrgTz,
  applyUnsubscribe,
  createRoutine,
  type DeliveryOut,
  deliverEffect,
  describeUnsubscribe,
  effectFailed,
  finishAgentRun,
  getRoutine,
  getRun,
  leaveRoutine,
  listRoutines,
  MAX_ROUTINES,
  MAX_ROUTINES_EACH,
  memberLeft,
  OWNER_CANT_REACH,
  othersPrivateCount,
  queueDueRoutines,
  type RoutineMessage,
  RoutineProblem,
  routineRunFailed,
  runRoutineNow,
  runRoutineRun,
  type ScheduleRule,
  setOrgTz,
  setRoutineStatus,
  startComposer,
  updateRoutine,
  VIEWERS_DONT_ASK,
} from "../src";
import { actor, jobDeps, member, verifiedSource } from "./helpers/checks";
import type { LearnedSource } from "./helpers/learned-source";

let s: LearnedSource;
const NOW = new Date("2026-10-11T09:00:00Z");
/** Monday at 07:00 in Berlin, the workspace's zone. */
const MONDAY = new Date("2026-10-12T05:00:00Z");
const bob = uuidv7();
const mondays: ScheduleRule = { every: "week", days: ["mon"], at: "07:00" };
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
const schedule = (action: unknown, rule: ScheduleRule = mondays) => ({
  version: 1,
  trigger: "schedule",
  rule,
  action,
});
const SIGNUPS = "How many accounts signed up last week?";
/** A question asked on Mondays at 07:00 (its source is known once the workspace is). */
const asking = (question = SIGNUPS) => schedule({ kind: "ask", connectionId: s.connectionId, question });
/** The Analyst's answer, as a run that answered leaves it. */
const ANSWERED = {
  kind: "answer",
  status: "answered",
  verified: true,
  markdown: "**212** accounts signed up last week.",
  rendered: "**212** accounts signed up last week.",
  interpretation: [],
  caveats: [],
  citations: [],
  values: [],
  problems: [],
};
const make = (spec: unknown, userIds: string[], who = actor(s)) =>
  s.tenant((tx) => createRoutine(tx, who, { spec, userIds }, NOW));
const problem = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (error) {
    if (error instanceof RoutineProblem) return error.message;
    throw error;
  }
};
const dispatch = (now: Date) =>
  queueDueRoutines(
    { withSystem: (fn) => withSystemOn(s.t.system, fn), withTenant: s.deps.withTenant, boss: s.boss },
    now,
  );
const runsOf = (routineId: string) =>
  s.t.owner<
    {
      id: string;
      trigger_key: string;
      status: string;
      run_id: string | null;
      error: string | null;
    }[]
  >`
    select id, trigger_key, status, run_id, error from app.routine_run
    where org_id = ${s.orgId} and routine_id = ${routineId} order by created_at`;
const effectsOf = (runId: string) =>
  s.t.owner<
    { id: string; status: string; recipient_key: string; idempotency_key: string; receipt: { reason?: string } }[]
  >`
    select id, status, recipient_key, idempotency_key, receipt from app.effect
    where org_id = ${s.orgId} and source_id = ${runId} order by created_at`;
const send = async (runId: string) => {
  for (const e of await effectsOf(runId)) {
    if (e.status === "queued")
      await deliverEffect({ ...s.deps, boss: s.boss }, { orgId: s.orgId, effectId: e.id }, out);
  }
};
const run = (routineRunId: string, now = MONDAY) => runRoutineRun(jobDeps(s), { orgId: s.orgId, routineRunId }, now);
/** A routine gone with everything it made (its runs and their sends), so no later test counts any of it. */
const drop = async (routineId: string) => {
  await s.t.owner`delete from app.effect where org_id = ${s.orgId} and source_type = 'routine_run'
    and source_id in (select id from app.routine_run where routine_id = ${routineId})`;
  await s.t.owner`delete from app.routine where org_id = ${s.orgId} and id = ${routineId}`;
};
const endAgent = (runId: string, status: string, outcome: unknown) =>
  s.t.owner`update app.run set status = ${status}, outcome = ${s.t.owner.json(outcome as never)}, finished_at = now()
    where org_id = ${s.orgId} and id = ${runId}`;
/** The Analyst's run a routine run started. */
const agentRunOf = async (routineRunId: string) =>
  (await s.t.owner<{ run_id: string }[]>`select run_id from app.routine_run where id = ${routineRunId}`)[0]
    ?.run_id as string;
/** A scheduled question's run taken to its sends: the Analyst started, its run ended with the answer, and filed. */
const answered = async (routineRunId: string, now = MONDAY) => {
  expect(await run(routineRunId, now)).toBe("writing");
  const agentRunId = await agentRunOf(routineRunId);
  await endAgent(agentRunId, "succeeded", ANSWERED);
  expect(await finishAgentRun({ ...s.deps, boss: s.boss }, s.orgId, agentRunId)).toBe("sending");
  return agentRunId;
};

beforeAll(async () => {
  ({ s } = await verifiedSource(NOW));
  await member(s, s.userId, "maya@acme.example", "owner");
  await member(s, bob, "bob@acme.example");
  await s.tenant((tx) => setOrgTz(tx, actor(s), "Europe/Berlin", NOW));
}, 300_000);

afterAll(async () => {
  await s?.close();
});

describe("making a routine", () => {
  it("is anyone's for themselves; owners and admins reach others", async () => {
    const asBob = actor(s, bob, false);
    const own = schedule({ kind: "digest" });
    expect(await problem(make(own, [bob], asBob))).toBe("ok");
    expect(await problem(make(own, [bob, s.userId], asBob))).toBe(
      "Only owners and admins can make routines that reach other people.",
    );
    expect(await problem(make(own, []))).toBe("Pick who it's for.");
    expect(await problem(make(own, [uuidv7()]))).toBe("Someone you picked isn't in the workspace any more.");
    expect(
      await problem(
        make(schedule({ kind: "ask", connectionId: uuidv7(), question: "How are sign-ups?" }), [bob], asBob),
      ),
    ).toBe("That source doesn't exist any more.");
    expect(await problem(make({ ...own, version: 9 }, [bob], asBob))).not.toBe("ok");
    // Bob's routines that tell only him are his alone: Maya, an owner, sees how many there are, not what they are,
    // and can't open or change one; nor can another member.
    const [mine] = (await s.tenant((tx) => listRoutines(tx, asBob))).filter((r) => r.ownerId === bob);
    expect(mine).toMatchObject({ canEdit: true, nextRunAt: MONDAY.toISOString() });
    expect((await s.tenant((tx) => listRoutines(tx, actor(s)))).filter((r) => r.ownerId === bob)).toEqual([]);
    expect(await s.tenant((tx) => othersPrivateCount(tx, actor(s)))).toBeGreaterThan(0);
    expect(await s.tenant((tx) => getRoutine(tx, actor(s), mine?.id as string))).toBeNull();
    for (const who of [actor(s), actor(s, uuidv7(), false)]) {
      expect(await problem(s.tenant((tx) => setRoutineStatus(tx, who, mine?.id as string, "paused")))).toBe(
        "That routine doesn't exist.",
      );
    }
    await s.t.owner`update app.routine set deleted_at = now() where org_id = ${s.orgId}`;
  });
});

describe("a routine's runs and their sends", () => {
  let routine = "";
  it("is dispatched once per due time, the latest after an outage", async () => {
    routine = await make(asking(), [s.userId, bob]);
    expect(await dispatch(new Date(MONDAY.getTime() - 60_000))).toBe(0);
    expect(await dispatch(MONDAY)).toBe(1);
    expect(await dispatch(MONDAY)).toBe(0);
    expect((await runsOf(routine)).map((r) => r.trigger_key)).toEqual([`at:${MONDAY.toISOString()}`]);
    // Down for two Mondays: one run, for the latest.
    await s.t.owner`update app.routine set next_run_at = ${MONDAY} where id = ${routine}`;
    const late = new Date("2026-10-27T10:00:00Z");
    expect(await dispatch(late)).toBe(1);
    expect((await runsOf(routine)).map((r) => r.trigger_key).at(-1)).toBe("at:2026-10-26T06:00:00.000Z");
    expect((await s.tenant((tx) => getRoutine(tx, actor(s), routine)))?.nextRunAt).toBe("2026-11-02T06:00:00.000Z");
  });

  it("files its answer where everyone it reaches reads it, and sends each person what they can still read", async () => {
    const [first, second] = await runsOf(routine);
    expect(await run(first?.id as string)).toBe("writing");
    // A job delivered twice starts nothing twice.
    expect(await run(first?.id as string)).toBe("skipped");
    const agentRunId = await agentRunOf(first?.id as string);
    const answerOf = async (who: ReturnType<typeof actor>, routineRunId = first?.id) =>
      (await s.tenant((tx) => getRoutine(tx, who, routine)))?.runs.find((r) => r.id === routineRunId)?.answer;
    // Answered, not filed yet: its conversation is nobody's, so the routine's page links nobody to it.
    await endAgent(agentRunId, "succeeded", ANSWERED);
    expect(await answerOf(actor(s))).toBeNull();
    expect(await answerOf(actor(s, bob, false))).toBeNull();
    expect(await finishAgentRun({ ...s.deps, boss: s.boss }, s.orgId, agentRunId)).toBe("sending");
    expect(await finishAgentRun({ ...s.deps, boss: s.boss }, s.orgId, agentRunId)).toBeNull();
    // Filed: it reaches past Maya, so its conversation is the workspace's, and each person it reaches reads it.
    const [thread] = await s.t.owner<{ id: string; visibility: string; created_by: string | null }[]>`
      select t.id, t.visibility, t.created_by from app.run r join app.thread t on t.org_id = r.org_id and t.id = r.thread_id
      where r.id = ${agentRunId}`;
    expect(thread).toMatchObject({ visibility: "org", created_by: null });
    const link = { threadId: thread?.id, runId: agentRunId };
    expect(await answerOf(actor(s))).toEqual(link);
    expect(await answerOf(actor(s, bob, false))).toEqual(link);
    expect((await effectsOf(first?.id as string)).map((e) => e.idempotency_key).sort()).toEqual(
      [`routine_run:${first?.id}:email:user:${s.userId}`, `routine_run:${first?.id}:email:user:${bob}`].sort(),
    );
    messages.length = 0;
    await send(first?.id as string);
    expect((await effectsOf(first?.id as string)).map((e) => [e.recipient_key, e.status]).sort()).toEqual(
      [
        [`user:${bob}`, "sent"],
        [`user:${s.userId}`, "sent"],
      ].sort(),
    );
    expect((await runsOf(routine))[0]?.status).toBe("delivered");
    // Each email says why it came, for its reader, and links to the answer in its conversation.
    const emails = messages.filter((m) => m.kind === "answer");
    expect(emails.map((m) => m.because).sort()).toEqual([
      `Every Monday at 07:00, ask “${SIGNUPS}” and send the answer to me and bob.`,
      `Every Monday at 07:00, ask “${SIGNUPS}” and send the answer to me and maya.`,
    ]);
    for (const email of emails) {
      expect(email.kind === "answer" && email.answer).toMatchObject({
        ...link,
        question: SIGNUPS,
        answer: "212 accounts signed up last week.",
        verified: true,
      });
      expect(email.routineUrl).toBe(`https://app.opendash.example/routines/${routine}`);
    }
    // A conversation nobody may read any more by the time its send goes (made private since): nothing goes, and
    // nobody is linked to it.
    const later = await answered(second?.id as string);
    await s.t.owner`update app.thread set visibility = 'private'
      where id = (select thread_id from app.run where id = ${later})`;
    await send(second?.id as string);
    expect((await effectsOf(second?.id as string)).map((e) => [e.status, e.receipt.reason])).toEqual([
      ["suppressed", "That answer isn't theirs to read any more."],
      ["suppressed", "That answer isn't theirs to read any more."],
    ]);
    expect((await runsOf(routine))[1]).toMatchObject({
      status: "skipped",
      error: "That answer isn't theirs to read any more.",
    });
    expect(await answerOf(actor(s), second?.id)).toBeNull();
  });

  it("doesn't send an email again that an attempt stopped in the middle of, and the run says so", async () => {
    const mine = await make(schedule({ kind: "digest" }), [s.userId]);
    expect(await s.tenant((tx) => runRoutineNow(tx, s.boss, actor(s), mine, MONDAY))).toBe("queued");
    const [now] = await runsOf(mine);
    expect(await run(now?.id as string)).toBe("sending");
    const [e] = await effectsOf(now?.id as string);
    // The worker went away after it claimed the send: the row is left sending.
    await s.t.owner`update app.effect set status = 'sending', attempt = 1 where id = ${e?.id as string}`;
    const sent = messages.length;
    expect(await deliverEffect({ ...s.deps, boss: s.boss }, { orgId: s.orgId, effectId: e?.id as string }, out)).toBe(
      "unknown",
    );
    expect(messages.length).toBe(sent);
    expect((await runsOf(mine))[0]).toMatchObject({ status: "failed", error: "A send couldn't go." });
    // Not stuck: Run now runs it again.
    expect(await s.tenant((tx) => runRoutineNow(tx, s.boss, actor(s), mine, new Date(MONDAY.getTime() + 1)))).toBe(
      "queued",
    );
    await drop(mine);
  });

  it("goes back in the queue when its work throws after the claim, and a late send settles nothing", async () => {
    const mine = await make(asking(), [s.userId]);
    await s.tenant((tx) => runRoutineNow(tx, s.boss, actor(s), mine, MONDAY));
    const [queued] = await runsOf(mine);
    // The database drops away after the claim: the run is put back for the job's retry, not left running.
    let calls = 0;
    const flaky = {
      ...jobDeps(s),
      withTenant: ((orgId: string, fn: never) =>
        calls++ === 1 ? Promise.reject(new Error("CONNECT_TIMEOUT")) : s.deps.withTenant(orgId, fn)) as never,
    };
    await expect(runRoutineRun(flaky, { orgId: s.orgId, routineRunId: queued?.id as string }, MONDAY)).rejects.toThrow(
      "CONNECT_TIMEOUT",
    );
    expect((await runsOf(mine))[0]?.status).toBe("queued");
    await answered(queued?.id as string);
    // A slow first attempt that comes back after a later one took the row over doesn't settle it.
    const [e] = await effectsOf(queued?.id as string);
    const late: DeliveryOut = {
      ...out,
      sender: {
        send: async () => {
          await s.t.owner`update app.effect set attempt = attempt + 1 where id = ${e?.id as string}`;
          return { id: "late" };
        },
      },
    };
    await deliverEffect({ ...s.deps, boss: s.boss }, { orgId: s.orgId, effectId: e?.id as string }, late);
    expect((await effectsOf(queued?.id as string))[0]?.status).toBe("sending");
    await drop(mine);
  });

  it("is taken over by its job's retry, even left running, and the attempt it was taken from writes nothing", async () => {
    const question = "Which plans grew last week?";
    const mine = await make(asking(question), [s.userId]);
    await s.tenant((tx) => runRoutineNow(tx, s.boss, actor(s), mine, MONDAY));
    const [queued] = await runsOf(mine);
    const routineRunId = queued?.id as string;
    // The database goes after the claim, and putting the run back fails too: it's left running, and the error that
    // stopped the work is the one reported.
    let calls = 0;
    const down = {
      ...jobDeps(s),
      withTenant: ((orgId: string, fn: never) =>
        calls++ >= 1 ? Promise.reject(new Error("CONNECT_TIMEOUT")) : s.deps.withTenant(orgId, fn)) as never,
    };
    await expect(runRoutineRun(down, { orgId: s.orgId, routineRunId }, MONDAY)).rejects.toThrow("CONNECT_TIMEOUT");
    expect((await runsOf(mine))[0]?.status).toBe("running");
    // An attempt that's slow (its work held up) when the retry takes the run over: the retry starts the Analyst, and
    // the slow one, back, starts nothing.
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let slowCalls = 0;
    const slow = {
      ...jobDeps(s),
      withTenant: (async (orgId: string, fn: never) => {
        if (slowCalls++ === 1) await gate;
        return s.deps.withTenant(orgId, fn);
      }) as never,
    };
    const first = runRoutineRun(slow, { orgId: s.orgId, routineRunId }, MONDAY);
    while (slowCalls < 2) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await run(routineRunId)).toBe("writing");
    release();
    expect(await first).toBe("skipped");
    const [after] = await s.t.owner<{ status: string; attempt: number }[]>`
      select status, attempt from app.routine_run where id = ${routineRunId}`;
    expect(after).toEqual({ status: "writing", attempt: 3 });
    const [started] = await s.t.owner<{ n: number }[]>`
      select count(*)::int as n from app.run r join app.thread t on t.org_id = r.org_id and t.id = r.thread_id
      where r.org_id = ${s.orgId} and t.channel = 'routine' and t.title = ${question}`;
    expect(started?.n).toBe(1);
    await drop(mine);
  });

  it("finishes whichever step it stops at, the retry sending each person one email (the crash matrix)", async () => {
    const ours = await make(asking(), [s.userId, bob]);
    // A run from its claim to its sends: the routine's job, the Analyst's run (ended by hand), then the worker's part.
    const through = async (deps: ReturnType<typeof jobDeps>, routineRunId: string) => {
      await runRoutineRun(deps, { orgId: s.orgId, routineRunId }, MONDAY);
      const agentRunId = await agentRunOf(routineRunId);
      await endAgent(agentRunId, "succeeded", ANSWERED);
      return finishAgentRun(deps, s.orgId, agentRunId);
    };
    // How many times a run reaches the database, start to end.
    let total = 0;
    const counting = {
      ...jobDeps(s),
      withTenant: ((orgId: string, fn: never) => {
        total++;
        return s.deps.withTenant(orgId, fn);
      }) as never,
    };
    // A new run each time: the last one's sends went, so it isn't under way.
    let at = MONDAY.getTime();
    const fresh = async () => {
      at += 1_000;
      expect(await s.tenant((tx) => runRoutineNow(tx, s.boss, actor(s), ours, new Date(at)))).toBe("queued");
      return (await runsOf(ours)).at(-1)?.id as string;
    };
    // Each email it queued, sent and counted.
    const sendAll = async (id: string) => {
      let sent = 0;
      const counted: DeliveryOut = { ...out, sender: { send: async () => ({ id: `email-${++sent}` }) } };
      for (const e of await effectsOf(id))
        await deliverEffect({ ...s.deps, boss: s.boss }, { orgId: s.orgId, effectId: e.id }, counted);
      return sent;
    };
    const whole = await fresh();
    expect(await through(counting, whole)).toBe("sending");
    expect(total).toBeGreaterThan(2);
    expect(await sendAll(whole)).toBe(2);
    // Each step in turn: the database goes there, then the job's retry carries on.
    for (let stop = 0; stop < total; stop++) {
      const id = await fresh();
      let calls = 0;
      const crashing = {
        ...jobDeps(s),
        withTenant: ((orgId: string, fn: never) =>
          calls++ === stop ? Promise.reject(new Error("CONNECT_TIMEOUT")) : s.deps.withTenant(orgId, fn)) as never,
      };
      await expect(through(crashing, id)).rejects.toThrow("CONNECT_TIMEOUT");
      expect(await through(jobDeps(s), id)).toBe("sending");
      expect((await effectsOf(id)).map((e) => e.recipient_key).sort()).toEqual(
        [`user:${bob}`, `user:${s.userId}`].sort(),
      );
      expect({ stop, sent: await sendAll(id), status: (await runsOf(ours)).at(-1)?.status }).toEqual({
        stop,
        sent: 2,
        status: "delivered",
      });
    }
    await drop(ours);
  });

  it("is delivered when anything went, saying who it didn't reach, and its streak starts again", async () => {
    const ours = await make(asking(), [s.userId, bob]);
    await s.t.owner`update app.routine set failure_streak = 3 where id = ${ours}`;
    await s.tenant((tx) => runRoutineNow(tx, s.boss, actor(s), ours, MONDAY));
    const [r] = await runsOf(ours);
    await answered(r?.id as string);
    const bounces: DeliveryOut = {
      ...out,
      sender: {
        send: async (m) => {
          if (m.to === "bob@acme.example")
            throw Object.assign(new Error("Mailbox unavailable"), { outcome: "rejected" });
          return { id: "went" };
        },
      },
    };
    for (const e of await effectsOf(r?.id as string)) {
      await deliverEffect({ ...s.deps, boss: s.boss }, { orgId: s.orgId, effectId: e.id }, bounces);
    }
    expect((await runsOf(ours))[0]).toMatchObject({ status: "delivered", error: "It went, but didn't reach bob." });
    expect(
      (await s.t.owner<{ failure_streak: number }[]>`select failure_streak from app.routine where id = ${ours}`)[0],
    ).toEqual({ failure_streak: 0 });
    await drop(ours);
  });

  it("fails a send its dead letter gave up on, and the run with it when nothing went, once", async () => {
    const mine = await make(schedule({ kind: "digest" }), [s.userId]);
    await s.tenant((tx) => runRoutineNow(tx, s.boss, actor(s), mine, MONDAY));
    const [r] = await runsOf(mine);
    // Its send stopped the worker every time: queued for its job, never sent.
    await s.t.owner`update app.routine_run set status = 'sending' where id = ${r?.id as string}`;
    const effect = uuidv7();
    await s.t.owner`insert into app.effect (org_id, id, purpose, source_type, source_id, channel, recipient_key,
        payload, idempotency_key)
      values (${s.orgId}, ${effect}, 'notify', 'routine_run', ${r?.id as string}, 'email', ${`user:${s.userId}`},
        ${s.t.owner.json({ kind: "digest", routineId: mine, userId: s.userId } as never)},
        ${`routine_run:${r?.id}:email:user:${s.userId}`})`;
    await effectFailed({ ...s.deps, boss: s.boss }, { orgId: s.orgId, effectId: effect });
    await effectFailed({ ...s.deps, boss: s.boss }, { orgId: s.orgId, effectId: effect });
    expect((await effectsOf(r?.id as string)).map((e) => e.status)).toEqual(["failed"]);
    expect((await runsOf(mine))[0]).toMatchObject({ status: "failed", error: "A send couldn't go." });
    const [streak] = await s.t.owner<
      { failure_streak: number }[]
    >`select failure_streak from app.routine where id = ${mine}`;
    expect(streak?.failure_streak).toBe(1);
    await drop(mine);
  });

  it("sends an email at most once: only one the provider surely didn't take is tried again", async () => {
    const mine = await make(asking(), [s.userId]);
    let at = MONDAY.getTime();
    const oneSend = async () => {
      at += 1;
      await s.tenant((tx) => runRoutineNow(tx, s.boss, actor(s), mine, new Date(at)));
      const r = (await runsOf(mine)).at(-1);
      await answered(r?.id as string);
      const [e] = await effectsOf(r?.id as string);
      return { run: r?.id as string, effect: e?.id as string };
    };
    let tries = 0;
    const failing = (outcome?: string): DeliveryOut => ({
      ...out,
      sender: {
        send: async () => {
          tries++;
          throw Object.assign(new Error(`It didn't go (${outcome ?? "no outcome"}).`), outcome ? { outcome } : {});
        },
      },
    });
    const deliver = (effectId: string, o: DeliveryOut, deps = s.deps) =>
      deliverEffect({ ...deps, boss: s.boss }, { orgId: s.orgId, effectId }, o);
    // Never taken (refused for now, or never reached): back in the queue, and the job's retry sends it.
    const a = await oneSend();
    await expect(deliver(a.effect, failing("not_sent"))).rejects.toThrow("not_sent");
    expect((await effectsOf(a.run))[0]?.status).toBe("queued");
    expect(await deliver(a.effect, out)).toBe("sent");
    expect((await runsOf(mine)).at(-1)?.status).toBe("delivered");
    // Refused for good: failed, nothing to retry.
    const b = await oneSend();
    expect(await deliver(b.effect, failing("rejected"))).toBe("failed");
    expect((await effectsOf(b.run))[0]?.status).toBe("failed");
    // Cut off, or a failure that doesn't say: it may have gone, so it isn't sent again.
    for (const outcome of ["unclear", undefined]) {
      const c = await oneSend();
      expect(await deliver(c.effect, failing(outcome))).toBe("unknown");
      expect((await effectsOf(c.run))[0]?.receipt.reason).toBe(
        "The email provider didn't confirm it, so it isn't sent again in case it went.",
      );
    }
    expect(tries).toBe(4);
    // It went, then recording that failed: not a failed send. The retry finds it sending and doesn't send it again.
    const d = await oneSend();
    let sends = 0;
    const counting: DeliveryOut = { ...out, sender: { send: async () => ({ id: `email-${++sends}` }) } };
    let calls = 0;
    const flaky = {
      ...s.deps,
      withTenant: ((orgId: string, fn: never) =>
        calls++ === 1 ? Promise.reject(new Error("CONNECT_TIMEOUT")) : s.deps.withTenant(orgId, fn)) as never,
    };
    await expect(deliver(d.effect, counting, flaky)).rejects.toThrow("CONNECT_TIMEOUT");
    expect(await deliver(d.effect, counting)).toBe("unknown");
    expect(sends).toBe(1);
    await drop(mine);
  });

  it("is left by its unsubscribe link, and pauses when it reaches nobody", async () => {
    const target = { orgId: s.orgId, userId: bob, routineId: routine };
    expect(await s.tenant((tx) => describeUnsubscribe(tx, target))).toMatchObject({ on: true });
    expect(await s.tenant((tx) => applyUnsubscribe(tx, target))).toBe(true);
    expect(await s.tenant((tx) => applyUnsubscribe(tx, target))).toBe(false);
    // Left: its link no longer says what the routine does now.
    expect(await s.tenant((tx) => describeUnsubscribe(tx, target))).toMatchObject({
      on: false,
      what: "a routine's emails",
    });
    expect((await s.tenant((tx) => getRoutine(tx, actor(s), routine)))?.userIds).toEqual([s.userId]);
    // Maya leaves her own: it reached only her, so it's gone.
    expect(await s.tenant((tx) => leaveRoutine(tx, actor(s), routine))).toBe(true);
    expect(await s.tenant((tx) => getRoutine(tx, actor(s), routine))).toBeNull();
  });
});

describe("what OpenDash found", () => {
  it("is composed for each person when it's sent, and not sent with nothing to say", async () => {
    const routine = await make(schedule({ kind: "digest" }), [s.userId]);
    expect(await s.tenant((tx) => runRoutineNow(tx, s.boss, actor(s), routine, MONDAY))).toBe("queued");
    expect(await s.tenant((tx) => runRoutineNow(tx, s.boss, actor(s), routine, MONDAY))).toBe("under_way");
    const [r] = await runsOf(routine);
    expect(await run(r?.id as string)).toBe("sending");
    await send(r?.id as string);
    expect((await effectsOf(r?.id as string))[0]?.receipt.reason).toBe("Nothing to say this time.");
    expect((await runsOf(routine))[0]).toMatchObject({ status: "skipped", error: "Nothing to say this time." });
  });
});

describe("a question on a schedule", () => {
  it("is answered by the Analyst in a conversation of its owner's alone when it reaches only them, and sent", async () => {
    const routine = await make(asking(), [s.userId]);
    expect(await s.tenant((tx) => runRoutineNow(tx, s.boss, actor(s), routine, MONDAY))).toBe("queued");
    const [r] = await runsOf(routine);
    expect(await run(r?.id as string)).toBe("writing");
    const [row] = await runsOf(routine);
    const [agent] = await s.t.owner<
      { trigger: string; profile: string; channel: string; created_by: string | null; author_id: string | null }[]
    >`
      select r.trigger, r.profile, t.channel, t.created_by, m.author_id from app.run r
      join app.thread t on t.org_id = r.org_id and t.id = r.thread_id
      join app.message m on m.org_id = r.org_id and m.id = r.input_message_id where r.id = ${row?.run_id as string}`;
    // It reaches only her, so its conversation is hers alone; the question has no
    // author, so the Analyst reads the workspace's knowledge, never her memory.
    expect(agent).toEqual({
      trigger: "routine",
      profile: "analyst",
      channel: "routine",
      created_by: s.userId,
      author_id: null,
    });
    const [job] = await s.t.owner<{ data: unknown }[]>`
      select data from pgboss.job where name = 'agent.background' and data->>'runId' = ${row?.run_id as string}`;
    expect(job?.data).toEqual({ orgId: s.orgId, runId: row?.run_id });
    await endAgent(row?.run_id as string, "succeeded", ANSWERED);
    expect(await finishAgentRun({ ...s.deps, boss: s.boss }, s.orgId, row?.run_id as string)).toBe("sending");
    // Filed where it was asked, and still hers alone: her routine's page links her to it; nobody else, owners and
    // admins included, reads it.
    const [thread] = await s.t.owner<{ id: string; visibility: string; created_by: string | null }[]>`
      select t.id, t.visibility, t.created_by from app.run r join app.thread t on t.org_id = r.org_id and t.id = r.thread_id
      where r.id = ${row?.run_id as string}`;
    expect(thread).toMatchObject({ visibility: "private", created_by: s.userId });
    const link = { threadId: thread?.id, runId: row?.run_id };
    expect((await s.tenant((tx) => getRoutine(tx, actor(s), routine)))?.lastRun?.answer).toEqual(link);
    expect(await getRun(s.deps, { orgId: s.orgId, userId: s.userId }, row?.run_id as string)).not.toBeNull();
    expect(await getRun(s.deps, { orgId: s.orgId, userId: bob }, row?.run_id as string, { manages: true })).toBeNull();
    messages.length = 0;
    await send(row?.id as string);
    // It names the source it was asked of (the run keeps none of its own).
    const [source] = await s.t.owner<{ name: string }[]>`select name from app.connection where id = ${s.connectionId}`;
    expect(messages[0]?.kind === "answer" && messages[0].answer).toMatchObject({
      ...link,
      question: SIGNUPS,
      sourceName: source?.name,
      answer: "212 accounts signed up last week.",
    });
  });

  it("files its answer as the routine reaches when it's done, with the question it answered", async () => {
    const threadOf = async (agentRunId: string) =>
      (
        await s.t.owner<{ id: string; visibility: string; created_by: string | null }[]>`
          select t.id, t.visibility, t.created_by from app.run r
          join app.thread t on t.org_id = r.org_id and t.id = r.thread_id where r.id = ${agentRunId}`
      )[0];
    // Asked for her and Bob, then narrowed to her alone, and its question changed, while the Analyst was writing.
    const narrowed = await make(asking(), [s.userId, bob]);
    expect(await s.tenant((tx) => runRoutineNow(tx, s.boss, actor(s), narrowed, MONDAY))).toBe("queued");
    const [first] = await runsOf(narrowed);
    expect(await run(first?.id as string)).toBe("writing");
    const agentRunId = await agentRunOf(first?.id as string);
    expect(await threadOf(agentRunId)).toMatchObject({ visibility: "private", created_by: null });
    await s.tenant((tx) =>
      updateRoutine(tx, actor(s), narrowed, { spec: asking("Which plans grew last week?"), userIds: [s.userId] }),
    );
    await endAgent(agentRunId, "succeeded", ANSWERED);
    expect(await finishAgentRun({ ...s.deps, boss: s.boss }, s.orgId, agentRunId)).toBe("sending");
    // Hers alone now, so hers to open: the routine's page links her to it, and her email says what it answered.
    const thread = await threadOf(agentRunId);
    expect(thread).toMatchObject({ visibility: "private", created_by: s.userId });
    expect((await s.tenant((tx) => getRoutine(tx, actor(s), narrowed)))?.lastRun?.answer).toEqual({
      threadId: thread?.id,
      runId: agentRunId,
    });
    messages.length = 0;
    await send(first?.id as string);
    expect(messages.map((m) => (m.kind === "answer" ? m.answer.question : m.kind))).toEqual([SIGNUPS]);
    await drop(narrowed);

    // Asked for her alone, then widened to Bob too: the workspace's conversation, nobody's to add to.
    const widened = await make(asking(), [s.userId]);
    expect(await s.tenant((tx) => runRoutineNow(tx, s.boss, actor(s), widened, MONDAY))).toBe("queued");
    const [second] = await runsOf(widened);
    expect(await run(second?.id as string)).toBe("writing");
    const widenedRun = await agentRunOf(second?.id as string);
    expect(await threadOf(widenedRun)).toMatchObject({ visibility: "private", created_by: s.userId });
    await s.tenant((tx) => updateRoutine(tx, actor(s), widened, { spec: asking(), userIds: [s.userId, bob] }));
    await endAgent(widenedRun, "succeeded", ANSWERED);
    expect(await finishAgentRun({ ...s.deps, boss: s.boss }, s.orgId, widenedRun)).toBe("sending");
    expect(await threadOf(widenedRun)).toMatchObject({ visibility: "org", created_by: null });
    expect(await getRun(s.deps, { orgId: s.orgId, userId: bob }, widenedRun)).not.toBeNull();
    await drop(widened);
  });

  it("fails when it couldn't be answered, and four failures in a row pause it and tell its owner", async () => {
    const routine = await make(asking("What about the thing?"), [s.userId]);
    for (let i = 0; i < 4; i++) {
      const now = new Date(MONDAY.getTime() + i * 60_000);
      expect(await s.tenant((tx) => runRoutineNow(tx, s.boss, actor(s), routine, now))).toBe("queued");
      const r = (await runsOf(routine)).at(-1);
      if (i < 3) {
        expect(await run(r?.id as string, now)).toBe("writing");
        const [row] = await s.t.owner<
          { run_id: string }[]
        >`select run_id from app.routine_run where id = ${r?.id as string}`;
        await endAgent(row?.run_id as string, "succeeded", { kind: "clarify", question: "Which thing?" });
        expect(await finishAgentRun({ ...s.deps, boss: s.boss }, s.orgId, row?.run_id as string)).toBe("failed");
      } else {
        // The last one dies with its job: the dead letter fails it.
        await routineRunFailed({ ...s.deps, boss: s.boss }, { orgId: s.orgId, routineRunId: r?.id as string });
      }
    }
    expect((await runsOf(routine)).map((r) => r.error)).toEqual([
      "It needed to ask something back. Make the question more specific.",
      "It needed to ask something back. Make the question more specific.",
      "It needed to ask something back. Make the question more specific.",
      "It couldn't finish, twice.",
    ]);
    const paused = await s.tenant((tx) => getRoutine(tx, actor(s), routine));
    expect(paused).toMatchObject({ status: "paused", nextRunAt: null });
    expect(paused?.pausedReason).toMatch(/^It failed 4 times in a row\. Last time: It couldn't finish, twice\./);
    // Its owner is told, once.
    const last = (await runsOf(routine)).at(-1);
    const notices = (await effectsOf(last?.id as string)).filter((e) => e.idempotency_key.includes(":paused:"));
    expect(notices).toHaveLength(1);
    messages.length = 0;
    await send(last?.id as string);
    expect(messages.map((m) => m.kind)).toEqual(["paused"]);
    // Paused, its runs don't run; resumed, it starts afresh.
    expect(await problem(s.tenant((tx) => runRoutineNow(tx, s.boss, actor(s), routine, MONDAY)))).toBe(
      "Resume it first.",
    );
    await s.tenant((tx) => setRoutineStatus(tx, actor(s), routine, "active", MONDAY));
    expect(await s.tenant((tx) => getRoutine(tx, actor(s), routine))).toMatchObject({
      status: "active",
      pausedReason: null,
    });
  });
});

describe("who sees and runs a routine", () => {
  it("is listed to its owner, its people, and owners and admins; one that tells only its owner is theirs", async () => {
    const mine = await make(asking("How am I doing?"), [s.userId]);
    const ours = await make(schedule({ kind: "digest" }), [s.userId, bob]);
    const asBob = actor(s, bob, false);
    const seen = (await s.tenant((tx) => listRoutines(tx, asBob))).map((r) => r.id);
    expect(seen).toContain(ours);
    expect(seen).not.toContain(mine);
    expect(await s.tenant((tx) => getRoutine(tx, asBob, mine))).toBeNull();
    // Another member sees the team's routines, never someone's own.
    const someone = actor(s, uuidv7(), false);
    expect((await s.tenant((tx) => listRoutines(tx, someone))).map((r) => r.id)).toEqual(
      expect.arrayContaining([ours]),
    );
    expect((await s.tenant((tx) => listRoutines(tx, someone))).map((r) => r.id)).not.toContain(mine);
    expect((await s.tenant((tx) => listRoutines(tx, actor(s)))).map((r) => r.id)).toEqual(
      expect.arrayContaining([mine, ours]),
    );
  });

  it("pauses when its owner can't reach other people any more, and resumes only for someone who can", async () => {
    const ours = await make(schedule({ kind: "digest" }), [s.userId, bob]);
    expect(await s.tenant((tx) => runRoutineNow(tx, s.boss, actor(s), ours, MONDAY))).toBe("queued");
    const [r] = await runsOf(ours);
    await s.t
      .owner`update auth.member set role = 'member' where organization_id = ${s.orgId} and user_id = ${s.userId}`;
    try {
      expect(await run(r?.id as string)).toBe("skipped");
      expect(await s.tenant((tx) => getRoutine(tx, actor(s, s.userId, false), ours))).toMatchObject({
        status: "paused",
        pausedReason: "Its owner isn't an owner or admin any more, so it can't reach other people.",
      });
      expect(await problem(s.tenant((tx) => setRoutineStatus(tx, actor(s, s.userId, false), ours, "active")))).toBe(
        "Only owners and admins can make routines that reach other people.",
      );
      // Nor does an admin's resume take: it would run as hers, and only pause again.
      expect(await problem(s.tenant((tx) => setRoutineStatus(tx, actor(s, bob, true), ours, "active")))).toBe(
        OWNER_CANT_REACH,
      );
    } finally {
      await s.t
        .owner`update auth.member set role = 'owner' where organization_id = ${s.orgId} and user_id = ${s.userId}`;
    }
    await s.tenant((tx) => setRoutineStatus(tx, actor(s), ours, "active", MONDAY));
    expect((await s.tenant((tx) => getRoutine(tx, actor(s), ours)))?.status).toBe("active");
  });

  it("is a viewer's only when it sends what's there: no question or working out why", async () => {
    const viewer = uuidv7();
    await member(s, viewer, "vera@acme.example", "viewer");
    const asViewer = actor(s, viewer, false);
    const ask = schedule({ kind: "ask", question: "Which plans grew?", connectionId: s.connectionId });
    expect(await problem(make(ask, [viewer], asViewer))).toBe(VIEWERS_DONT_ASK);
    expect(await problem(make(schedule({ kind: "digest" }), [viewer], asViewer))).toBe("ok");
    expect(
      await problem(
        s.tenant((tx) =>
          startComposer(
            tx,
            { boss: s.boss, deploymentKeys: { anthropic: true } as never },
            { orgId: s.orgId, userId: viewer, text: "Email me MRR weekly", people: [], channels: [], canManage: false },
          ),
        ),
      ),
    ).toBe("Viewers pick each part below; Describe it is for members.");
    // A member's question, then they're made a viewer: its next run pauses it, saying why.
    const bobs = await make(ask, [bob], actor(s, bob, false));
    await s.tenant((tx) => runRoutineNow(tx, s.boss, actor(s, bob, false), bobs, MONDAY));
    const [r] = await runsOf(bobs);
    await s.t.owner`update auth.member set role = 'viewer' where organization_id = ${s.orgId} and user_id = ${bob}`;
    try {
      expect(await run(r?.id as string)).toBe("skipped");
      expect(await s.tenant((tx) => getRoutine(tx, actor(s, bob, false), bobs))).toMatchObject({
        status: "paused",
        pausedReason: VIEWERS_DONT_ASK,
      });
      expect(await problem(s.tenant((tx) => setRoutineStatus(tx, actor(s, bob, false), bobs, "active")))).toBe(
        VIEWERS_DONT_ASK,
      );
    } finally {
      await s.t.owner`update auth.member set role = 'member' where organization_id = ${s.orgId} and user_id = ${bob}`;
    }
    const theirs = await s.t.owner<{ id: string }[]>`
      select id from app.routine where org_id = ${s.orgId} and (id = ${bobs} or owner_id = ${viewer})`;
    for (const r of theirs) await drop(r.id);
    await s.t.owner`delete from auth.member where organization_id = ${s.orgId} and user_id = ${viewer}`;
  });
});

describe("people leaving", () => {
  it("are taken off what emails them, and what they owned pauses", async () => {
    const someone = uuidv7();
    await member(s, someone, "sam@acme.example");
    const theirs = await make(schedule({ kind: "digest" }), [someone], actor(s, someone, false));
    const shared = await make(schedule({ kind: "digest" }), [s.userId, someone]);
    await s.t.owner`delete from auth.member where organization_id = ${s.orgId} and user_id = ${someone}`;
    await s.tenant((tx) => memberLeft(tx, s.orgId, someone));
    expect((await s.tenant((tx) => getRoutine(tx, actor(s), shared)))?.userIds).toEqual([s.userId]);
    // Theirs alone, so it's read here as stored: paused, saying why.
    expect(
      (
        await s.t.owner<{ status: string; paused_reason: string }[]>`
        select status, paused_reason from app.routine where id = ${theirs}`
      )[0],
    ).toEqual({ status: "paused", paused_reason: "Its owner left the workspace." });
  });

  it("move with the workspace's time zone", async () => {
    const routine = await make(schedule({ kind: "digest" }), [s.userId]);
    expect((await s.tenant((tx) => getRoutine(tx, actor(s), routine)))?.nextRunAt).toBe(MONDAY.toISOString());
    await s.tenant((tx) => setOrgTz(tx, actor(s), "Asia/Tokyo", NOW));
    expect((await s.tenant((tx) => getRoutine(tx, actor(s), routine)))?.nextRunAt).toBe("2026-10-11T22:00:00.000Z");
    expect(await problem(s.tenant((tx) => setOrgTz(tx, actor(s, bob, false), "UTC", NOW)))).toBe(
      "Only owners and admins set the workspace's time zone.",
    );
    expect(await problem(s.tenant((tx) => setOrgTz(tx, actor(s), "Mars/Olympus", NOW)))).toBe(
      "Pick a time zone from the list.",
    );
    // Due when the zone changes: it still runs, rather than moving to next week.
    const due = await make(schedule({ kind: "digest" }), [s.userId]);
    await s.t.owner`update app.routine set next_run_at = ${new Date(NOW.getTime() - 60_000)} where id = ${due}`;
    await s.tenant((tx) => setOrgTz(tx, actor(s), "Europe/Berlin", NOW));
    expect((await s.tenant((tx) => getRoutine(tx, actor(s), due)))?.nextRunAt).toBe(
      new Date(NOW.getTime() - 60_000).toISOString(),
    );
    // A roundup waiting for 07:00 waits for 07:00 of its day where the workspace is now.
    const waiting = uuidv7();
    await s.t.owner`insert into app.routine_run (org_id, id, routine_id, trigger_key, status, due_at)
      values (${s.orgId}, ${waiting}, ${routine}, 'roundup:2026-10-12', 'waiting', '2026-10-12T05:00:00Z')`;
    await s.tenant((tx) => setOrgTz(tx, actor(s), "America/New_York", NOW));
    const [moved] = await s.t.owner<{ due_at: Date }[]>`select due_at from app.routine_run where id = ${waiting}`;
    expect(moved?.due_at.toISOString()).toBe("2026-10-12T11:00:00.000Z");
    await s.tenant((tx) => setOrgTz(tx, actor(s), "Europe/Berlin", NOW));
    await drop(routine);
    await drop(due);
  });
});

describe("a new workspace's time zone", () => {
  it("is its creator's browser's while it's still the default, and never one someone chose", async () => {
    await s.tenant((tx) => setOrgTz(tx, actor(s), "UTC", NOW));
    expect(await s.tenant((tx) => adoptOrgTz(tx, actor(s, bob, false), "Asia/Tokyo", NOW))).toBe(false);
    expect(await s.tenant((tx) => adoptOrgTz(tx, actor(s), "Not/AZone", NOW))).toBe(false);
    expect(await s.tenant((tx) => adoptOrgTz(tx, actor(s), "Asia/Tokyo", NOW))).toBe(true);
    expect(await s.tenant((tx) => adoptOrgTz(tx, actor(s), "America/New_York", NOW))).toBe(false);
    const [o] = await s.t.owner<{ tz: string }[]>`select tz from app.org where id = ${s.orgId}`;
    expect(o?.tz).toBe("Asia/Tokyo");
    await s.tenant((tx) => setOrgTz(tx, actor(s), "Europe/Berlin", NOW));
  });
});

describe("sharing the dispatcher between workspaces", () => {
  it("queues each workspace's first due routine before any one's second, and keeps a workspace to 200", async () => {
    const r = await make(schedule({ kind: "digest" }), [s.userId]);
    const copy = (orgId: string, n: number, at: Date) =>
      s.t.owner`
        insert into app.routine (org_id, id, name, owner_id, trigger, spec, user_ids, slack, next_run_at)
        select ${orgId}, gen_random_uuid(), name, owner_id, trigger, spec, user_ids, slack, ${at}
        from app.routine cross join generate_series(1, ${n}) where id = ${r}`;
    // Sixty of this workspace's routines due before another workspace's one: a tick takes 50.
    const other = uuidv7();
    await createOrg(s.t, other, "Lumen");
    await copy(s.orgId, 60, new Date(NOW.getTime() - 7_200_000));
    await copy(other, 1, new Date(NOW.getTime() - 3_600_000));
    try {
      expect(await dispatch(NOW)).toBe(50);
      const [queued] = await s.t.owner<{ n: number }[]>`
        select count(*)::int as n from app.routine_run where org_id = ${other}`;
      expect(queued?.n).toBe(1);
      const again = () => problem(make(schedule({ kind: "digest" }), [s.userId]));
      // Fifty of their own at most: one member can't fill the workspace with routines only they can delete.
      expect(await again()).toBe(
        `Each person keeps ${MAX_ROUTINES_EACH} routines at most: delete one that isn't needed first.`,
      );
      // Two hundred running in the workspace at most: the next one, or a paused one resumed, is refused; paused ones
      // (as a member's who left) don't count.
      await s.t.owner`update app.routine set owner_id = ${bob} where org_id = ${s.orgId} and id <> ${r}`;
      const [active] = await s.t.owner<{ n: number }[]>`
        select count(*)::int as n from app.routine where org_id = ${s.orgId} and deleted_at is null and status = 'active'`;
      await copy(s.orgId, MAX_ROUTINES - (active?.n ?? 0), new Date(NOW.getTime() + 86_400_000));
      await s.t.owner`update app.routine set owner_id = ${bob} where org_id = ${s.orgId} and id <> ${r}`;
      expect(await again()).toBe(`A workspace runs ${MAX_ROUTINES} routines at most: pause or delete one first.`);
      await s.tenant((tx) => setRoutineStatus(tx, actor(s), r, "paused", NOW));
      await copy(s.orgId, 1, new Date(NOW.getTime() + 86_400_000));
      expect(await problem(s.tenant((tx) => setRoutineStatus(tx, actor(s), r, "active", NOW)))).toBe(
        `A workspace runs ${MAX_ROUTINES} routines at most: pause or delete one first.`,
      );
      await s.t.owner`update app.routine set status = 'paused' where org_id = ${s.orgId} and owner_id = ${bob}`;
      expect(await again()).toBe("ok");
    } finally {
      await s.t.owner`update app.routine set deleted_at = now() where org_id in (${s.orgId}, ${other})`;
    }
  });
});

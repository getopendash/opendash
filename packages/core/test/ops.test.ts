// Observability v0: alerts as rows, who can read them, the dispatcher's
// checks (stuck runs, lost jobs, quiet dead letters), and usage rolled up by day.
import { readdirSync, readFileSync } from "node:fs";
import { type SystemTx, sql, uuidv7 } from "@opendash/db";
import { createOrg, withSystemOn } from "@opendash/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createLogger,
  deadLettered,
  orgAlerts,
  orgHealth,
  partitionsChecked,
  QUEUES,
  raiseAlert,
  rollupUsage,
  STUCK_RUN_SECONDS,
  submitQuestion,
  systemTick,
  tickIsLate,
} from "../src";
import { type LearnedSource, learnedSource } from "./helpers/learned-source";

let s: LearnedSource;
const lines: string[] = [];
const log = createLogger({}, (_level, line) => lines.push(line));
let deps: {
  withSystem: <T>(fn: (tx: SystemTx) => Promise<T>) => Promise<T>;
  log: typeof log;
};
const T0 = new Date("2026-10-11T12:00:00Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const alerts = (kind?: string) =>
  s.t.owner<{ org_id: string | null; kind: string; subject: string; count: number; resolved_at: Date | null }[]>`
    select org_id, kind, subject, count, resolved_at from app.ops_alert
    where ${kind ? s.t.owner`kind = ${kind}` : s.t.owner`true`} order by first_seen_at`;

beforeAll(async () => {
  s = await learnedSource();
  deps = { withSystem: (fn) => withSystemOn(s.t.system, fn), log };
}, 300_000);

afterAll(async () => {
  await s?.close();
});

describe("alerts", () => {
  it("never shows a tenant the deployment's alerts, nor another organization's", async () => {
    await raiseAlert(deps, {
      orgId: null,
      kind: "partitions_missing",
      subject: "partitions",
      message: "Missing.",
    });
    const other = uuidv7();
    await createOrg(s.t, other, "Other");
    await raiseAlert(deps, { orgId: other, kind: "dead_letter", subject: "connection.test.dlq", message: "Other's." });
    await raiseAlert(deps, { orgId: s.orgId, kind: "dead_letter", subject: "connection.test.dlq", message: "Ours." });
    const mine = await s.tenant((tx) => orgAlerts(tx, s.orgId));
    expect(mine.map((a) => a.message)).toEqual(["Ours."]);
    // Even asking for the deployment's directly, through the tenant's role: nothing.
    const direct = await s.tenant((tx) =>
      tx.execute<{ n: number }>(sql`select count(*)::int as n from app.ops_alert where org_id is null`),
    );
    expect(direct[0]?.n).toBe(0);
    await s.t.owner`delete from app.ops_alert`;
  });

  it("is one open row per kind and subject, counted again while it holds, logged once", async () => {
    lines.length = 0;
    const first = await raiseAlert(deps, { orgId: s.orgId, kind: "dead_letter", subject: "q", message: "One." }, at(0));
    const again = await raiseAlert(deps, { orgId: s.orgId, kind: "dead_letter", subject: "q", message: "Two." }, at(1));
    expect(first.created).toBe(true);
    expect(again).toEqual({ id: first.id, created: false });
    expect(await alerts("dead_letter")).toEqual([
      expect.objectContaining({ org_id: s.orgId, subject: "q", count: 2, resolved_at: null }),
    ]);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({
      level: "error",
      msg: "alert",
      kind: "dead_letter",
      subject: "q",
    });
  });

  it("raises a dead letter for the organization whose job it was, and resolves it after a quiet day", async () => {
    await deadLettered(
      deps,
      { queue: "connection.test.dlq", orgId: s.orgId, message: "A connection test never finished." },
      at(0),
    );
    const mine = await s.tenant((tx) => orgAlerts(tx, s.orgId));
    expect(mine.find((a) => a.subject === "connection.test.dlq")).toMatchObject({
      kind: "dead_letter",
      message: "A connection test never finished.",
    });
    await systemTick({ ...deps, boss: s.boss, now: () => at(23 * 60) });
    expect((await alerts("dead_letter")).every((a) => a.resolved_at === null)).toBe(true);
    await systemTick({ ...deps, boss: s.boss, now: () => at(25 * 60) });
    expect((await alerts("dead_letter")).every((a) => a.resolved_at !== null)).toBe(true);
    await s.t.owner`delete from app.ops_alert`;
  });

  it("runs every task even when one throws, and still records that it ran", async () => {
    const ran: string[] = [];
    await systemTick({
      ...deps,
      boss: s.boss,
      now: () => at(30),
      tasks: [
        async () => {
          throw new Error("a task broke");
        },
        async () => {
          ran.push("second");
        },
      ],
    });
    expect(ran).toEqual(["second"]);
    const [tick] = await s.t.owner<{ at: Date }[]>`select at from app.ops_tick where name = 'system.tick'`;
    expect(tick?.at.toISOString()).toBe(at(30).toISOString());
  });

  it("keeps the deployment's partitions alert open while partitions are missing", async () => {
    await partitionsChecked(deps, 2, at(0));
    await partitionsChecked(deps, 2, at(60));
    expect(await alerts("partitions_missing")).toEqual([
      expect.objectContaining({ org_id: null, count: 2, resolved_at: null }),
    ]);
    await partitionsChecked(deps, 0, at(120));
    expect((await alerts("partitions_missing"))[0]?.resolved_at).not.toBeNull();
    await s.t.owner`delete from app.ops_alert`;
  });
});

describe("the dispatcher", () => {
  const ask = () =>
    submitQuestion(
      { withTenant: s.deps.withTenant, boss: s.boss },
      { orgId: s.orgId, userId: s.userId, connectionId: s.connectionId, text: "MRR?", channel: "web", model: "m" },
    );

  it("alarms on a run stuck past its limit, counts it while it stays, and clears when it ends", async () => {
    const { runId } = await ask();
    const started = at(0);
    await s.t.owner`
      update app.run set status = 'running', attempt = 1, attempt_started_at = ${started}, started_at = ${started}
      where id = ${runId}`;
    const before = await systemTick({ ...deps, boss: s.boss, now: () => at(STUCK_RUN_SECONDS.interactive / 60 - 1) });
    expect(before.stuck).toBe(0);
    expect(
      await systemTick({ ...deps, boss: s.boss, now: () => at(STUCK_RUN_SECONDS.interactive / 60 + 1) }),
    ).toMatchObject({
      stuck: 1,
    });
    await systemTick({ ...deps, boss: s.boss, now: () => at(STUCK_RUN_SECONDS.interactive / 60 + 2) });
    const [alert] = await alerts("stuck_run");
    expect(alert).toMatchObject({ org_id: s.orgId, subject: runId, count: 2, resolved_at: null });
    const [view] = await s.tenant((tx) => orgAlerts(tx, s.orgId));
    // As the limit is set (budgets), not a number pinned here.
    const limit = STUCK_RUN_SECONDS.interactive / 60;
    expect(view?.message).toMatch(new RegExp(`^Running for ${limit + 2} minutes, past its ${limit}-minute limit\\.`));
    await s.t.owner`update app.run set status = 'failed', finished_at = now() where id = ${runId}`;
    const after = await systemTick({ ...deps, boss: s.boss, now: () => at(STUCK_RUN_SECONDS.interactive / 60 + 3) });
    expect(after).toMatchObject({ stuck: 0, resolved: 1 });
    expect((await alerts("stuck_run"))[0]?.resolved_at).not.toBeNull();
    await s.t.owner`delete from app.ops_alert`;
  });

  it("gives a background agent's run its queue's longer limit", async () => {
    const { runId } = await ask();
    const started = at(0);
    await s.t.owner`
      update app.run set status = 'running', profile = 'modeler', attempt = 1, attempt_started_at = ${started},
        started_at = ${started}
      where id = ${runId}`;
    const tick = (minute: number) => systemTick({ ...deps, boss: s.boss, now: () => at(minute) });
    expect((await tick(STUCK_RUN_SECONDS.interactive / 60 + 1)).stuck).toBe(0);
    expect((await tick(STUCK_RUN_SECONDS.background / 60 + 1)).stuck).toBe(1);
    await s.t.owner`update app.run set status = 'failed', finished_at = now() where id = ${runId}`;
    await tick(STUCK_RUN_SECONDS.background / 60 + 2);
    await s.t.owner`delete from app.ops_alert`;
  });

  it("sends a long-queued run again only when its job was lost, and says so", async () => {
    const { runId } = await ask();
    await s.t.owner`update app.run set queued_at = ${at(-10)} where id = ${runId}`;
    // Its job is live: sending again does nothing.
    expect(await systemTick({ ...deps, boss: s.boss, now: () => at(0) })).toMatchObject({ lostJobs: 0 });
    expect(await alerts("lost_job")).toEqual([]);
    // Lost: the job is gone, so the send creates one, and that's an alert.
    await s.t.owner`delete from pgboss.job where name = 'agent.interactive' and singleton_key = ${runId}`;
    expect(await systemTick({ ...deps, boss: s.boss, now: () => at(1) })).toMatchObject({ lostJobs: 1 });
    const [job] = await s.t.owner<{ data: { runId: string } }[]>`
      select data from pgboss.job where name = 'agent.interactive' and singleton_key = ${runId}`;
    expect(job?.data.runId).toBe(runId);
    expect(await alerts("lost_job")).toEqual([expect.objectContaining({ subject: runId, resolved_at: null })]);
    await s.t.owner`update app.run set status = 'failed', finished_at = now() where id = ${runId}`;
    await systemTick({ ...deps, boss: s.boss, now: () => at(2) });
    expect((await alerts("lost_job"))[0]?.resolved_at).not.toBeNull();
    await s.t.owner`delete from app.ops_alert`;
  });

  it("leaves a child run to its parent: never sent to a pool, never alerted on", async () => {
    const parent = await ask();
    const child = await ask();
    // A drafter its lead started, queued (refused for money, or just before a crash), and one running long.
    await s.t.owner`delete from pgboss.job where name = 'agent.interactive' and singleton_key = ${child.runId}`;
    await s.t.owner`
      update app.run set profile = 'drafter', parent_run_id = ${parent.runId}, queued_at = ${at(-10)}
      where id = ${child.runId}`;
    await s.t.owner`update app.run set status = 'failed', finished_at = now() where id = ${parent.runId}`;
    const tick = (minute: number) => systemTick({ ...deps, boss: s.boss, now: () => at(minute) });
    expect(await tick(0)).toMatchObject({ lostJobs: 0 });
    const [job] = await s.t.owner<{ n: number }[]>`
      select count(*)::int as n from pgboss.job where singleton_key = ${child.runId}`;
    expect(job?.n).toBe(0);
    await s.t.owner`
      update app.run set status = 'running', attempt = 1, attempt_started_at = ${at(0)}, started_at = ${at(0)}
      where id = ${child.runId}`;
    expect((await tick(STUCK_RUN_SECONDS.background / 60 + 1)).stuck).toBe(0);
    await s.t.owner`update app.run set status = 'failed', finished_at = now() where id = ${child.runId}`;
    await s.t.owner`delete from app.ops_alert`;
  });

  it("records when it ran, which says whether it's late", async () => {
    await systemTick({ ...deps, boss: s.boss, now: () => at(0) });
    const [row] = await s.tenant((tx) =>
      tx.execute<{ at: Date | null }>(sql`select app.last_tick('system.tick') as at`),
    );
    const last = row?.at ? new Date(row.at) : null;
    expect(last?.toISOString()).toBe(at(0).toISOString());
    expect(tickIsLate(last, at(2))).toBe(false);
    expect(tickIsLate(last, at(4))).toBe(true);
    expect(tickIsLate(null, at(0))).toBe(true);
    // The table itself is the system's.
    const read = await s.tenant((tx) => tx.execute<{ n: number }>(sql`select count(*)::int as n from app.ops_tick`));
    expect(read[0]?.n).toBe(0);
  });
});

describe("usage by day", () => {
  it("equals the events to the cent, by day and model, and stays the same when rolled up again", async () => {
    const event = (day: string, model: string | null, qty: number, cost: number | null, key = "deployment") =>
      s.t.system.client`
        insert into app.usage_event (id, org_id, kind, qty, unit, model, provider, key_source, cost_usd, source_type, source_id)
        values (app.uuidv7_floor(${`${day}T10:00:00Z`}::timestamptz), ${s.orgId}, 'llm_tokens', ${qty}, 'tokens', ${model},
          'anthropic', ${key}, ${cost}, 'run', ${uuidv7()})`;
    // The 1st and 2nd of next month, rolled up on the 2nd: a new database has usage_event partitions from its own
    // month on (ensure_partitions), so a fixed date has none once the calendar passes it.
    const today = new Date();
    const [d1, d2] = [1, 2].map((d) =>
      new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, d)).toISOString().slice(0, 10),
    ) as [string, string];
    const on = (minutes: number) => new Date(Date.parse(`${d2}T12:00:00Z`) + minutes * 60_000);
    await event(d1, "claude-sonnet-5-5", 1000, 0.012345);
    await event(d1, "claude-sonnet-5-5", 500, 0.000001);
    await event(d2, "claude-haiku-5-5", 300, null);
    await event(d2, "claude-haiku-5-5", 200, 0.0004, "org");
    const once = await rollupUsage(deps, on(0));
    const twice = await rollupUsage(deps, on(30));
    expect(twice).toEqual(once);
    const rows = await s.t.owner<
      {
        day: string;
        model: string;
        key_source: string;
        events: number;
        qty: string;
        cost_usd: string;
        unpriced: number;
      }[]
    >`
      select to_char(day, 'YYYY-MM-DD') as day, model, key_source, events, qty::text, cost_usd::text, unpriced
      from app.usage_daily where org_id = ${s.orgId} order by day, model, key_source`;
    expect(rows).toEqual([
      {
        day: d1,
        model: "claude-sonnet-5-5",
        key_source: "deployment",
        events: 2,
        qty: "1500",
        cost_usd: "0.012346",
        unpriced: 0,
      },
      {
        day: d2,
        model: "claude-haiku-5-5",
        key_source: "deployment",
        events: 1,
        qty: "300",
        cost_usd: "0.000000",
        unpriced: 1,
      },
      {
        day: d2,
        model: "claude-haiku-5-5",
        key_source: "org",
        events: 1,
        qty: "200",
        cost_usd: "0.000400",
        unpriced: 0,
      },
    ]);
    const [events] = await s.t.owner<{ cost: string }[]>`
      select sum(cost_usd)::numeric(14,6)::text as cost from app.usage_event
      where org_id = ${s.orgId} and id >= app.uuidv7_floor(${`${d1}T00:00:00Z`}::timestamptz)`;
    const [daily] = await s.t.owner<{ cost: string }[]>`
      select sum(cost_usd)::text as cost from app.usage_daily where org_id = ${s.orgId}`;
    expect(daily?.cost).toBe(events?.cost);
  });
});

describe("Settings → Health", () => {
  it("names a stalled question only to whoever may read its conversation, and links a source's alert", async () => {
    const teammate = uuidv7();
    const own = await submitQuestion(
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
    const theirs = await submitQuestion(
      { withTenant: s.deps.withTenant, boss: null },
      {
        orgId: s.orgId,
        userId: teammate,
        connectionId: s.connectionId,
        text: "My private question",
        channel: "web",
        model: "m",
      },
    );
    for (const runId of [own.runId, theirs.runId]) {
      await s.t
        .owner`update app.run set status = 'running', attempt = 1, attempt_started_at = ${at(0)} where id = ${runId}`;
    }
    await systemTick({ ...deps, boss: s.boss, now: () => at(STUCK_RUN_SECONDS.interactive / 60 + 1) });
    const [sync] = await s.t.owner<{ id: string }[]>`
      select id from app.sync_run where connection_id = ${s.connectionId} limit 1`;
    await deadLettered(deps, {
      queue: "catalog.sync.dlq",
      orgId: s.orgId,
      message: "Learning a source didn't finish.",
      detail: { syncRunId: sync?.id },
    });
    await s.t
      .owner`update app.run set status = 'failed', error = 'The analyst stopped unexpectedly. Ask again.', finished_at = now() where id = ${own.runId}`;
    const health = await s.tenant((tx) => orgHealth(tx, { orgId: s.orgId, userId: s.userId }));
    const stalled = health.open.filter((a) => a.kind === "stuck_run");
    expect(stalled).toContainEqual(
      expect.objectContaining({
        title: "A question stalled",
        context: "“Why did churn drop?”",
        href: `/ask/${own.threadId}`,
      }),
    );
    expect(stalled).toContainEqual(
      expect.objectContaining({ context: "A teammate's private conversation", href: null, action: null }),
    );
    expect(JSON.stringify(health)).not.toContain("My private question");
    expect(health.open.find((a) => a.kind === "dead_letter")).toMatchObject({
      title: "Learning a source didn't finish",
      href: `/data/sources/${s.connectionId}`,
      action: "Open source",
    });
    expect(health.failed).toContainEqual(
      expect.objectContaining({ reason: "The analyst stopped unexpectedly. Ask again.", questions: 1 }),
    );
    await s.t.owner`update app.run set status = 'failed', finished_at = now() where id = ${theirs.runId}`;
    await s.t.owner`delete from app.ops_alert`;
  });
});

describe("the queues", () => {
  it("each have a dead-letter queue that exists, so no job dies unnoticed", () => {
    const names = new Set(QUEUES.map((q) => q.name));
    const missing = QUEUES.filter((q) => !q.name.endsWith(".dlq") && !q.options.deadLetter).map((q) => q.name);
    expect(missing).toEqual([]);
    for (const q of QUEUES) if (q.options.deadLetter) expect(names.has(q.options.deadLetter)).toBe(true);
  });

  it("each have a handler in the worker, dead letters included, so nothing queued is left unworked", () => {
    const definitions = readFileSync(new URL("../src/jobs/queues.ts", import.meta.url), "utf8");
    // Each queue's names in code: where it's defined, and any export that's another name for it.
    const named = new Map<string, string>(
      [...definitions.matchAll(/(?:export )?const (\w+) = define<[\s\S]*?>\(\s*"([^"]+)"/g)].map(
        (m) => [m[1] as string, m[2] as string] as const,
      ),
    );
    for (const [, alias, of] of definitions.matchAll(/export const (\w+) = (\w+);/g)) {
      const name = named.get(of as string);
      if (name) named.set(alias as string, name);
    }
    const identsOf = (name: string) => [...named].filter(([, n]) => n === name).map(([ident]) => ident);
    const dir = new URL("../../../apps/worker/src/", import.meta.url);
    const worker = readdirSync(dir)
      .filter((f) => f.endsWith(".ts"))
      .map((f) => readFileSync(new URL(f, dir), "utf8"))
      .join("\n");
    // Worked by `boss.work(queue.name, …)`, or by `workDraining(boss, queue, …)` for a queue someone waits on.
    const worked = (ident: string) =>
      new RegExp(`\\.work(?:<[^>]*>)?\\(\\s*${ident}\\.name`).test(worker) ||
      new RegExp(`workDraining(?:<[^>]*>)?\\(\\s*\\w+,\\s*${ident}\\b`).test(worker);
    const unworked = QUEUES.filter((q) => !identsOf(q.name).some(worked)).map((q) => q.name);
    expect(unworked).toEqual([]);
  });
});

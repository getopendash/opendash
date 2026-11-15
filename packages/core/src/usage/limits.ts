/**
 * Spend limits: what an organization lets AI spend in a calendar month
 * and a day (UTC), counted from usage_event's priced calls on any key, so the limits and Settings → Usage agree to the
 * cent. Held when a question is asked; a question already running finishes.
 */
import { type SystemTx, sql, type TenantTx } from "@opendash/db";
import { type AuditActor, audit } from "../audit/write";
import { BUDGETS } from "../budgets";
import { raiseAlert, resolveAlerts, type SystemDeps } from "../ops/alerts";
import { BACKGROUND_PROFILES, BACKGROUND_TRIGGERS } from "../runs/background";
import { lockFor } from "../tenancy/locks";

export interface SpendLimits {
  monthlyUsd: number | null;
  dailyUsd: number | null;
  /** Background work's budget for the month (the Investigator, routines); 0 turns it off. */
  backgroundMonthlyUsd: number;
  /**
   * Where a person's run in OpenDash pauses and asks to go on, as the workspace sets it; null: it doesn't pause,
   * and only the monthly and daily limits hold.
   */
  runCeilingUsd: number | null;
}

/** Background work's monthly budget when an owner hasn't set one. */
export const BACKGROUND_BUDGET_USD = 10;
/** Where a person's run pauses when an owner hasn't said: a little past the biggest of a hundred recorded runs. */
export const RUN_CEILING_USD = 1.5;

/**
 * What one run may still spend under the workspace's monthly and daily limits: what's left of the tighter one once the
 * other runs going on now have their holds, plus what this run has spent already (the limits count it). Null when
 * neither limit is set. A run started without a ceiling still stops here: the limits are
 * checked when a question is asked, and a run that pauses rather than ends could otherwise spend past them. The spend
 * and the others' holds are one statement's: a run's spend landing between two reads can't count twice.
 */
export async function roomForRun(
  tx: TenantTx | SystemTx,
  orgId: string,
  runId: string,
  now: Date = new Date(),
): Promise<number | null> {
  const { limits } = await spendView(tx, orgId, now);
  if (limits.monthlyUsd === null && limits.dailyUsd === null) return null;
  const t = await taken(tx, orgId, now, runId);
  const left = [
    limits.monthlyUsd === null ? null : limits.monthlyUsd - t.month - t.heldByQuestions,
    limits.dailyUsd === null ? null : limits.dailyUsd - t.day - t.heldByQuestions,
  ].filter((n): n is number => n !== null);
  const [own] = await tx.execute<{ usd: string }>(sql`
    select coalesce(sum(cost_usd), 0)::text as usd from app.usage_event
    where org_id = ${orgId} and source_type = 'run' and source_id = ${runId}`);
  return Math.max(0, Math.min(...left)) + Number(own?.usd ?? 0);
}

/** A person's run's ceiling when there's none set: big enough never to be the one that pauses it. */
export const NO_CEILING_USD = 10_000;

/**
 * Reserves what a person's run may spend, as it starts an attempt: its ceiling, never past what the limits leave it
 * (`roomForRun`), stored on the run (`hold_usd`) so `taken()` counts it for every other run and admission. Under the
 * organization's spend lock, as admission is, so two runs starting together can't both take the same room, and
 * written only while this attempt is the run's live one: a stale attempt can't shrink its retry's hold. Returns what
 * it may spend and whether the limits, not the ceiling, set that.
 */
export async function reserveForRun(
  tx: TenantTx | SystemTx,
  orgId: string,
  run: { id: string; attempt: number },
  now: Date = new Date(),
): Promise<{ spendable: number; ceilingUsd: number | null; byLimit: boolean }> {
  // The run's row first, then the spend lock: the order a follow-up's submission takes them in (it locks the answer
  // being worked on, then admits under the spend lock), so the two never wait on each other.
  const [live] = await tx.execute<{ id: string }>(sql`
    select id from app.run
    where org_id = ${orgId} and id = ${run.id} and attempt = ${run.attempt} and status in ('running', 'cancelling')
    for update`);
  await lockFor(tx, `spend:${orgId}`);
  const ceiling = await runCeiling(tx, orgId);
  const room = await roomForRun(tx, orgId, run.id, now);
  const cap = ceiling ?? NO_CEILING_USD;
  const spendable = Math.round(Math.min(cap, room ?? Number.POSITIVE_INFINITY) * 100) / 100;
  if (live)
    await tx.execute(sql`update app.run set hold_usd = ${spendable} where org_id = ${orgId} and id = ${run.id}`);
  return { spendable, ceilingUsd: ceiling, byLimit: room !== null && room < cap };
}

/** Where a person's run in this workspace pauses and asks to go on, or null when it doesn't. */
export async function runCeiling(tx: TenantTx | SystemTx, orgId: string): Promise<number | null> {
  const [row] = await tx.execute<{ v: string | null }>(sql`
    select run_ceiling_usd::text as v from app.spend_limit where org_id = ${orgId}`);
  if (!row) return RUN_CEILING_USD;
  return row.v === null ? null : Number(row.v);
}

export interface SpendView {
  limits: SpendLimits;
  /** The questions' spend (what their limits count), and background work's (what its budget counts). */
  spent: { month: number; day: number; background: number };
  /** When each period starts again (UTC). */
  resets: { month: string; day: string };
}

/** Background work can't start: this month's background budget is spent (or off). Its message says who can raise it. */
export class BackgroundBudgetReached extends Error {
  constructor(
    readonly budgetUsd: number,
    message: string,
  ) {
    super(message);
  }
}

/** A question can't be asked: a limit was reached. Its message says which, and who can raise it. */
export class SpendLimitReached extends Error {
  constructor(
    readonly period: "month" | "day",
    readonly limitUsd: number,
    message: string,
  ) {
    super(message);
  }
}

export class SpendLimitProblem extends Error {}

/** The share of a limit at which the organization is warned. */
export const SPEND_WARN_AT = 0.8;

const periods = (now: Date) => {
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const nextDay = new Date(day.getTime() + 24 * 3600_000);
  return { month, nextMonth, day, nextDay };
};

const money = (n: number) => `$${n.toFixed(2)}`;
const num = (v: string | number | null) => (v === null ? null : Number(v));

/**
 * What the organization spent this month and today (UTC), and its limits: the questions' spend, which their limits
 * count, apart from background work's, which only its own budget counts.
 */
export async function spendView(tx: TenantTx | SystemTx, orgId: string, now: Date = new Date()): Promise<SpendView> {
  const p = periods(now);
  const [row] = await tx.execute<{
    monthly_usd: string | null;
    daily_usd: string | null;
    background_monthly_usd: string | null;
    run_ceiling_usd: string | null;
    has_row: boolean;
    month: string;
    day: string;
    background: string;
  }>(sql`
    select l.monthly_usd, l.daily_usd, l.background_monthly_usd, l.run_ceiling_usd::text, l.org_id is not null as has_row,
      coalesce(sum(e.cost_usd) filter (where not e.background), 0)::text as month,
      coalesce(sum(e.cost_usd) filter (where not e.background
        and e.id >= app.uuidv7_floor(${p.day.toISOString()}::timestamptz)), 0)::text as day,
      coalesce(sum(e.cost_usd) filter (where e.background), 0)::text as background
    from (select ${orgId}::uuid as org_id) o
    left join app.spend_limit l on l.org_id = o.org_id
    left join app.usage_event e on e.org_id = o.org_id
      and e.id >= app.uuidv7_floor(${p.month.toISOString()}::timestamptz)
      and e.id < app.uuidv7_floor(${now.toISOString()}::timestamptz + interval '1 second')
    group by l.monthly_usd, l.daily_usd, l.background_monthly_usd, l.run_ceiling_usd, l.org_id`);
  return {
    limits: {
      monthlyUsd: num(row?.monthly_usd ?? null),
      dailyUsd: num(row?.daily_usd ?? null),
      backgroundMonthlyUsd: num(row?.background_monthly_usd ?? null) ?? BACKGROUND_BUDGET_USD,
      runCeilingUsd: row?.has_row ? num(row.run_ceiling_usd) : RUN_CEILING_USD,
    },
    spent: { month: Number(row?.month ?? 0), day: Number(row?.day ?? 0), background: Number(row?.background ?? 0) },
    resets: { month: p.nextMonth.toISOString(), day: p.nextDay.toISOString() },
  };
}

/**
 * The longest a run can go on spending once it has started: every attempt pg-boss gives it (retryLimit), each up to
 * its job's expiry, and a margin. A queued one holds until it runs or fails: an outage of the workers never lets a
 * second budget's worth in while the first waits, and one that waits too long is failed (failStaleQueuedRuns).
 */
const RUN_LIFE_SECONDS = {
  interactive:
    (BUDGETS.agent.retryLimit + 1) * (BUDGETS.agent.jobExpireSeconds + BUDGETS.agent.retryDelaySeconds) + 600,
  background:
    (BUDGETS.agent.retryLimit + 1) * (BUDGETS.agent.backgroundJobExpireSeconds + BUDGETS.agent.retryDelaySeconds) + 600,
};

/** What's spent this period and what unfinished runs still hold, read in one statement (one snapshot). */
interface Taken {
  month: number;
  day: number;
  background: number;
  /** What unfinished questions, and unfinished background work, may still spend. */
  heldByQuestions: number;
  heldByBackground: number;
}

/**
 * What the organization has spent this month and today, and what its unfinished runs may still spend: each lead run up
 * to its agent's cap (BUDGETS.agent.runCostCapsUsd), less what it and its children (a drafting batch's drafters spend
 * from their lead's cap) have spent so far. Admission counts the held part as spent, so work started together can't
 * each see the same room. One statement, so a call recorded between two reads can't be counted in neither (a call's
 * run total and its usage_event are written together, runs/ledger.ts). Every call recorded so far counts, however
 * long the lock took: none is cut off at `now`, which only picks the month and the day. `except` leaves out a run the
 * caller has already written and is now admitting.
 */
async function taken(tx: TenantTx | SystemTx, orgId: string, now: Date, except?: string): Promise<Taken> {
  const p = periods(now);
  const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000).toISOString();
  const caps = BUDGETS.agent.runCostCapsUsd;
  const cap = sql.join(
    Object.entries(caps).map(([profile, usd]) => sql`when ${profile} then ${usd}::numeric`),
    sql` `,
  );
  const list = (xs: readonly string[]) =>
    sql.join(
      xs.map((x) => sql`${x}`),
      sql`, `,
    );
  const [row] = await tx.execute<Record<keyof Taken, string>>(sql`
    with spent as (
      select coalesce(sum(e.cost_usd) filter (where not e.background), 0) as month,
        coalesce(sum(e.cost_usd) filter (where not e.background
          and e.id >= app.uuidv7_floor(${p.day.toISOString()}::timestamptz)), 0) as day,
        coalesce(sum(e.cost_usd) filter (where e.background), 0) as background
      from app.usage_event e
      where e.org_id = ${orgId} and e.id >= app.uuidv7_floor(${p.month.toISOString()}::timestamptz)
    ), lead as (
      select (r.trigger in (${list(BACKGROUND_TRIGGERS)}) or r.profile in (${list(BACKGROUND_PROFILES)})) as background,
        -- A person's run reserves what it may spend (its ceiling, or what the limits left it); others, their cap.
        greatest(coalesce(r.hold_usd, case r.profile ${cap} else ${Math.max(...Object.values(caps))}::numeric end)
          - coalesce((r.usage->>'costUsd')::numeric, 0)
          - coalesce((select sum(coalesce((c.usage->>'costUsd')::numeric, 0)) from app.run c
              where c.org_id = r.org_id and c.parent_run_id = r.id), 0), 0) as held
      from app.run r
      where r.org_id = ${orgId} and r.parent_run_id is null and r.status in ('queued', 'running', 'cancelling')
        and r.id is distinct from ${except ?? null}::uuid
        -- Not one past the longest it could still be spending (RUN_LIFE_SECONDS): a run nothing will run again (a
        -- worker gone mid-way, a job lost) mustn't hold its room for good.
        and case when r.status = 'queued' then true
          when r.profile = 'analyst' then coalesce(r.started_at, r.queued_at) >= ${ago(RUN_LIFE_SECONDS.interactive)}::timestamptz
          else coalesce(r.started_at, r.queued_at) >= ${ago(RUN_LIFE_SECONDS.background)}::timestamptz end
    )
    select spent.month::text, spent.day::text, spent.background::text,
      (select coalesce(sum(held) filter (where not background), 0) from lead)::text as "heldByQuestions",
      (select coalesce(sum(held) filter (where background), 0) from lead)::text as "heldByBackground"
    from spent`);
  return {
    month: Number(row?.month ?? 0),
    day: Number(row?.day ?? 0),
    background: Number(row?.background ?? 0),
    heldByQuestions: Number(row?.heldByQuestions ?? 0),
    heldByBackground: Number(row?.heldByBackground ?? 0),
  };
}

/**
 * Refuses background work (an investigation, a routine's run) once this month's background spend, with what the
 * background work still running may spend, has reached its budget: a hard stop until the month resets, passed by at
 * most the last run's own cap. The questions' limits are never touched by it. One admission at a time per organization.
 * `except` is the run being admitted, when the caller wrote it first (a routine's written summary).
 */
export async function checkBackgroundBudget(
  tx: TenantTx | SystemTx,
  orgId: string,
  now: Date = new Date(),
  options: { except?: string } = {},
): Promise<void> {
  await lockFor(tx, `spend:${orgId}`);
  const v = await spendView(tx, orgId, now);
  const budget = v.limits.backgroundMonthlyUsd;
  const t = await taken(tx, orgId, now, options.except);
  if (t.background + t.heldByBackground < budget) return;
  const on = new Date(v.resets.month).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const raise = "or an owner or admin can raise it in Settings → Usage.";
  throw new BackgroundBudgetReached(
    budget,
    budget === 0
      ? "Background work is off: an owner or admin can give it a budget in Settings → Usage."
      : t.background >= budget
        ? `This month's background budget (${money(budget)}) is spent. It starts again on ${on}, ${raise}`
        : `This month's background budget (${money(budget)}) is taken by background work still running. It goes on when that ends, ${raise}`,
  );
}

/**
 * Refuses a new question once the organization's spend, with what the questions still running may spend, has reached
 * a limit: passed by at most the last question's own cap. In the caller's transaction (the submit), so the refusal and
 * the question can't disagree; one admission at a time per organization.
 */
export async function checkSpend(tx: TenantTx, orgId: string, now: Date = new Date()): Promise<void> {
  const [limit] = await tx.execute<{ monthly_usd: string | null; daily_usd: string | null }>(sql`
    select monthly_usd, daily_usd from app.spend_limit where org_id = ${orgId}`);
  if (limit?.monthly_usd == null && limit?.daily_usd == null) return;
  await lockFor(tx, `spend:${orgId}`);
  const v = await spendView(tx, orgId, now);
  const t = await taken(tx, orgId, now);
  const spent = { month: t.month, day: t.day };
  const held = t.heldByQuestions;
  const [org] = await tx.execute<{ name: string }>(sql`select name from app.org where id = ${orgId}`);
  const who = org?.name ?? "Your organization";
  const raise = "or an owner or admin can raise the limit in Settings → Usage. Questions already running finish.";
  const running = "Questions still running take up the rest";
  if (v.limits.monthlyUsd !== null && spent.month + held >= v.limits.monthlyUsd) {
    const on = new Date(v.resets.month).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
    throw new SpendLimitReached(
      "month",
      v.limits.monthlyUsd,
      spent.month >= v.limits.monthlyUsd
        ? `${who} has reached this month's ${money(v.limits.monthlyUsd)} limit for AI. Questions start again on ${on}, ${raise}`
        : `${running} of this month's ${money(v.limits.monthlyUsd)} limit for AI. Ask again when they finish, ${raise}`,
    );
  }
  if (v.limits.dailyUsd !== null && spent.day + held >= v.limits.dailyUsd) {
    throw new SpendLimitReached(
      "day",
      v.limits.dailyUsd,
      spent.day >= v.limits.dailyUsd
        ? `${who} has reached today's ${money(v.limits.dailyUsd)} limit for AI. Questions start again at 00:00 UTC, ${raise}`
        : `${running} of today's ${money(v.limits.dailyUsd)} limit for AI. Ask again when they finish, ${raise}`,
    );
  }
}

const amount = (v: number | null, name: string) => {
  if (v === null) return null;
  if (!Number.isFinite(v) || v <= 0 || v > 1_000_000) {
    throw new SpendLimitProblem(`The ${name} limit has to be more than $0 and at most $1,000,000, or empty for none.`);
  }
  return Math.round(v * 100) / 100;
};

/**
 * Owners and admins: the organization's limits (null: none) and its background budget (0: off; left out, it stays as
 * it is).
 */
export async function setSpendLimits(
  tx: TenantTx,
  ctx: { orgId: string; userId: string | null; actor?: AuditActor },
  input: Omit<SpendLimits, "backgroundMonthlyUsd" | "runCeilingUsd"> & {
    backgroundMonthlyUsd?: number;
    /** Left out, it stays as it is; null: no ceiling. */
    runCeilingUsd?: number | null;
  },
): Promise<SpendLimits> {
  const monthly = amount(input.monthlyUsd, "monthly");
  const daily = amount(input.dailyUsd, "daily");
  const background = input.backgroundMonthlyUsd;
  if (background !== undefined && (!Number.isFinite(background) || background < 0 || background > 1_000_000)) {
    throw new SpendLimitProblem("The background budget has to be between $0 (off) and $1,000,000.");
  }
  const bg = background === undefined ? null : Math.round(background * 100) / 100;
  const ceiling = input.runCeilingUsd;
  if (ceiling !== undefined && ceiling !== null && (!Number.isFinite(ceiling) || ceiling <= 0 || ceiling > 10_000)) {
    throw new SpendLimitProblem("A run's ceiling has to be between $0.01 and $10,000, or none.");
  }
  const setCeiling = ceiling !== undefined;
  const ceilingValue = ceiling === undefined || ceiling === null ? null : Math.round(ceiling * 100) / 100;
  const [row] = await tx.execute<{ background_monthly_usd: string; run_ceiling_usd: string | null }>(sql`
    insert into app.spend_limit
      (org_id, monthly_usd, daily_usd, background_monthly_usd, run_ceiling_usd, updated_by, updated_at)
    values (${ctx.orgId}, ${monthly}, ${daily}, coalesce(${bg}::numeric, ${BACKGROUND_BUDGET_USD}),
      case when ${setCeiling} then ${ceilingValue}::numeric else ${RUN_CEILING_USD}::numeric end, ${ctx.userId}, now())
    on conflict (org_id) do update set monthly_usd = excluded.monthly_usd, daily_usd = excluded.daily_usd,
      background_monthly_usd = coalesce(${bg}::numeric, app.spend_limit.background_monthly_usd),
      run_ceiling_usd = case when ${setCeiling} then ${ceilingValue}::numeric else app.spend_limit.run_ceiling_usd end,
      updated_by = excluded.updated_by, updated_at = now()
    returning background_monthly_usd, run_ceiling_usd::text`);
  await audit(tx, {
    action: "spend_limit.updated",
    actor: ctx.actor ?? (ctx.userId ? { type: "user", id: ctx.userId } : undefined),
    target: { type: "workspace" },
    fields: [
      "monthlyUsd",
      "dailyUsd",
      ...(bg === null ? [] : ["backgroundMonthlyUsd"]),
      ...(setCeiling ? ["runCeilingUsd"] : []),
    ],
  });
  return {
    monthlyUsd: monthly,
    dailyUsd: daily,
    backgroundMonthlyUsd: Number(row?.background_monthly_usd),
    runCeilingUsd: row?.run_ceiling_usd == null ? null : Number(row.run_ceiling_usd),
  };
}

/**
 * The dispatcher's warning: an alert for each organization at or past 80% of a limit, one per period
 * (its subject names it, so a new period starts clear), resolved once it no longer holds (the limit raised).
 */
export async function warnSpend(deps: SystemDeps, now: Date = new Date()): Promise<number> {
  const orgs = await deps.withSystem((tx) =>
    tx.execute<{ org_id: string }>(sql`
      select org_id from app.spend_limit where monthly_usd is not null or daily_usd is not null`),
  );
  const p = periods(now);
  const holding: string[] = [];
  for (const { org_id } of orgs) {
    const v = await deps.withSystem((tx) => spendView(tx, org_id, now));
    const checks = [
      { period: "month", limit: v.limits.monthlyUsd, spent: v.spent.month, key: p.month.toISOString().slice(0, 7) },
      { period: "day", limit: v.limits.dailyUsd, spent: v.spent.day, key: p.day.toISOString().slice(0, 10) },
    ] as const;
    for (const c of checks) {
      if (c.limit === null || c.spent < c.limit * SPEND_WARN_AT) continue;
      const subject = `${org_id}:${c.period}:${c.key}`;
      holding.push(subject);
      const share = Math.floor((c.spent / c.limit) * 100);
      const which = c.period === "month" ? "this month's" : "today's";
      const until = c.period === "month" ? "the month turns" : "00:00 UTC";
      await raiseAlert(
        deps,
        {
          orgId: org_id,
          kind: "spend",
          subject,
          message:
            c.spent >= c.limit
              ? `${money(c.spent)} spent: ${which} ${money(c.limit)} limit is reached, and new questions are refused until ${until}. An owner or admin can raise it.`
              : `${money(c.spent)} spent, ${share}% of ${which} ${money(c.limit)} limit. New questions stop at the limit; an owner or admin can raise it.`,
          detail: { period: c.period, limitUsd: c.limit, spentUsd: c.spent },
        },
        now,
      );
    }
  }
  return resolveAlerts(deps, "spend", holding, now);
}

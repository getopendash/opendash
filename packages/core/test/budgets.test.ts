// The time-budget inequalities: no timer may fire before the work it bounds can finish.
import { MAX_FIXED_TIME_LIMIT_SECONDS } from "@opendash/connectors";
import { ROLE_SETTINGS } from "@opendash/db/bootstrap";
import { describe, expect, it } from "vitest";
import { BUDGETS, connectionTestWorstCaseMs } from "../src/budgets";
import { effectSendQueue, slackReplyQueue } from "../src/jobs/queues";
import { CALLS_PER_POST } from "../src/slack/api";

describe("time budgets", () => {
  it("a connection test's job outlives its slowest possible probe, with a margin", () => {
    const margin = 10_000;
    expect(BUDGETS.connectionTest.jobExpireSeconds * 1000).toBeGreaterThanOrEqual(connectionTestWorstCaseMs() + margin);
  });

  it("an analyst's job outlives its longest run (a dashboard's build, 9 min) and a slow tool, with a margin", () => {
    const build = 9 * 60_000;
    expect(build + BUDGETS.agent.tools.slowMs + 60_000).toBeLessThanOrEqual(BUDGETS.agent.jobExpireSeconds * 1000);
    expect(BUDGETS.agent.kinds.interactive.wallMs).toBeLessThanOrEqual(build);
  });

  it("a dead worker is noticed well before the job would expire anyway", () => {
    const b = BUDGETS.connectionTest;
    const detection =
      b.heartbeatSeconds + Math.max(BUDGETS.queue.superviseIntervalSeconds, BUDGETS.queue.monitorIntervalSeconds);
    expect(b.heartbeatSeconds).toBeGreaterThanOrEqual(10); // pg-boss's minimum
    expect(detection).toBeLessThan(b.jobExpireSeconds);
  });

  it("a sync job stops starting work in time to finish its current statement before it expires", () => {
    const b = BUDGETS.catalogSync;
    const margin = 60_000;
    expect(b.wallMs + b.statementMs * 4 + margin).toBeLessThanOrEqual(b.jobExpireSeconds * 1000);
    expect(b.heartbeatSeconds).toBeGreaterThanOrEqual(10);
  });

  it("the gateway keeps no more than it reads, and checks are quicker than runs", () => {
    const g = BUDGETS.gateway;
    expect(g.previewRows).toBeLessThanOrEqual(g.maxRows);
    expect(g.previewBytes).toBeLessThanOrEqual(g.maxBytes);
    expect(g.explainMs).toBeLessThan(g.statementMs);
  });

  it("a readonly = 1 ClickHouse user's server time limit is within the gateway's own", () => {
    expect(MAX_FIXED_TIME_LIMIT_SECONDS * 1000).toBeLessThanOrEqual(BUDGETS.gateway.statementMs);
  });

  it("an agent run's timers nest: statement < tool < wrap-up < wall < job expiry, for every kind", () => {
    const a = BUDGETS.agent;
    const g = BUDGETS.gateway;
    const finalizeMargin = 30_000;
    expect(g.statementMs + g.connectMs).toBeLessThan(a.tools.queryMs);
    expect(a.tools.quickMs).toBeLessThan(a.tools.queryMs);
    expect(a.tools.queryMs).toBeLessThan(a.tools.slowMs);
    const expiry = {
      interactive: a.jobExpireSeconds,
      background: a.backgroundJobExpireSeconds,
      drafting: a.backgroundJobExpireSeconds,
    };
    for (const [kind, k] of Object.entries(a.kinds)) {
      expect(k.wrapUpAtMs, kind).toBeLessThan(k.wallMs);
      // A slow tool started just before the wall still ends, and the run finalizes, before its job expires.
      expect(k.wallMs + a.tools.slowMs + finalizeMargin, kind).toBeLessThanOrEqual(
        expiry[kind as keyof typeof expiry] * 1000,
      );
    }
    // A drafter has at most its lead's time before the lead wraps up: its own wall ends it, and it
    // finishes, before its tool call's timer would cut it off.
    expect(a.tools.childMs).toBeGreaterThanOrEqual(a.kinds.drafting.wrapUpAtMs);
    expect(a.attemptFailures).toBeLessThan(a.retryLimit);
    expect(a.heartbeatSeconds).toBeGreaterThanOrEqual(10);
    expect(a.rowsToModel).toBeLessThanOrEqual(g.previewRows);
    expect(a.modelFirstByteMs).toBeLessThanOrEqual(a.modelIdleMs);
  });

  it("a routine waits for an investigation longer than one takes, so only a lost one goes unawaited", () => {
    const a = BUDGETS.agent;
    expect(BUDGETS.routines.investigateWaitMs).toBeGreaterThan(a.kinds.background.wallMs + a.tools.slowMs);
  });

  it("a send finishes inside its job: an email's own timers inside its budget, a channel post's every call", () => {
    const e = BUDGETS.email;
    const margin = 10_000;
    const expiry = BUDGETS.delivery.jobExpireSeconds * 1000;
    expect(effectSendQueue.options.expireInSeconds).toBe(BUDGETS.delivery.jobExpireSeconds);
    expect(e.smtpConnectMs).toBeLessThan(e.sendMs);
    expect(e.smtpSocketMs).toBeLessThan(e.sendMs);
    expect(e.sendMs + margin).toBeLessThan(expiry);
    expect(CALLS_PER_POST * BUDGETS.slack.apiMs + margin).toBeLessThan(expiry);
  });

  it("a Slack reply's job outlasts a call the chat client waits out a rate limit for, each time it may", () => {
    const s = BUDGETS.slack;
    // Slack asks for up to a minute's wait; the client's own backoff is at most 5 s between tries.
    const worstCall = (s.rateLimitRetries + 1) * s.apiMs + s.rateLimitRetries * (60_000 + 5_000);
    expect(worstCall).toBeLessThan((slackReplyQueue.options.expireInSeconds ?? 0) * 1000);
  });

  it("a minute's tick is over before the next, a provider's test inside its job, a search's vector inside its tool", () => {
    expect(BUDGETS.tick.jobExpireSeconds).toBeLessThan(60);
    expect(BUDGETS.aiProviderTest.listMs + BUDGETS.aiProviderTest.callMs * 3 + 10_000).toBeLessThan(
      BUDGETS.aiProviderTest.jobExpireSeconds * 1000,
    );
    expect(BUDGETS.embed.queryMs).toBeLessThan(BUDGETS.agent.tools.quickMs);
  });

  it("a lock is waited for well inside the app role's statement timeout, which the database's setup sets", () => {
    const set = ROLE_SETTINGS.find(([role, name]) => role === "opendash_app" && name === "statement_timeout");
    const seconds = Number(/^(\d+)s$/.exec(set?.[2] ?? "")?.[1]);
    expect(seconds).toBeGreaterThan(0);
    expect(BUDGETS.db.lockWaitMs * 2).toBeLessThanOrEqual(seconds * 1000);
  });

  it("the UI waits for a queued test longer than a healthy worker takes to pick it up", () => {
    expect(BUDGETS.connectionTest.queuedWarningMs).toBeGreaterThan(BUDGETS.queue.superviseIntervalSeconds * 1000);
  });
});

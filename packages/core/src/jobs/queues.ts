/**
 * Queues and their payloads. Payloads carry ids only:
 * every role that can enqueue can read the queue tables, so no secret or personal data goes in a job.
 */
import type { Queue } from "pg-boss";
import type { ProviderKind } from "../ai/kinds";
import { BUDGETS } from "../budgets";

export interface ConnectionTestJob {
  orgId: string;
  testId: string;
}

/** catalog.sync and catalog.history: one learning run of a source (sync_run), in two jobs. */
export interface CatalogSyncJob {
  orgId: string;
  connectionId: string;
  syncRunId: string;
}

/** agent.interactive: one Analyst run. */
export interface AgentRunJob {
  orgId: string;
  runId: string;
}

export interface QueueDefinition<T> {
  name: string;
  options: Omit<Queue, "name">;
  /** Typing only: the payload shape. */
  readonly payload?: T;
}

const define = <T>(name: string, options: Omit<Queue, "name">): QueueDefinition<T> => ({ name, options });

/**
 * connection.test: a failed probe is a result, not a job failure, so the handler never throws and the job is never
 * retried. A worker that dies or hangs lets the job expire into the dead-letter queue, whose handler fails the test.
 */
export const connectionTestQueue = define<ConnectionTestJob>("connection.test", {
  policy: "standard",
  retryLimit: 0,
  expireInSeconds: BUDGETS.connectionTest.jobExpireSeconds,
  heartbeatSeconds: BUDGETS.connectionTest.heartbeatSeconds,
  deadLetter: "connection.test.dlq",
  deleteAfterSeconds: 24 * 3600,
});

export const connectionTestDeadLetter = define<ConnectionTestJob>("connection.test.dlq", {
  policy: "standard",
  retryLimit: 3,
  retryDelay: 5,
  deleteAfterSeconds: 7 * 24 * 3600,
});

/**
 * Learning a source: catalog.sync reads the schema and profiles the tables, then hands over to catalog.history in the
 * same transaction that records its last step. Like connection.test, a failed step is a result written to the
 * sync_run, never a job failure; a dead or hung worker expires into the dead-letter queue, which fails the run.
 * `exclusive` per run, so a run's job is never queued twice; one active run per source is enforced by the database
 * (sync_run_active_uq).
 */
const syncDeadLetter = define<CatalogSyncJob>("catalog.sync.dlq", {
  policy: "standard",
  retryLimit: 3,
  retryDelay: 5,
  deleteAfterSeconds: 7 * 24 * 3600,
});

/**
 * Learning a source: each job is retried once, a minute later, when its delivery stalls (a worker restarted or hung
 * mid-run); the retry starts its step over and the stalled delivery's writes stop counting (sync_run.attempt).
 */
export const catalogSyncQueue = define<CatalogSyncJob>("catalog.sync", {
  policy: "exclusive",
  retryLimit: 1,
  retryDelay: 60,
  expireInSeconds: BUDGETS.catalogSync.jobExpireSeconds,
  heartbeatSeconds: BUDGETS.catalogSync.heartbeatSeconds,
  deadLetter: syncDeadLetter.name,
  deleteAfterSeconds: 7 * 24 * 3600,
});

/** A sync's last step, the team's query history (it was values.index: no values are kept now). */
export const catalogHistoryQueue = define<CatalogSyncJob>("catalog.history", {
  policy: "exclusive",
  retryLimit: 1,
  retryDelay: 60,
  expireInSeconds: BUDGETS.catalogSync.jobExpireSeconds,
  heartbeatSeconds: BUDGETS.catalogSync.heartbeatSeconds,
  deadLetter: syncDeadLetter.name,
  deleteAfterSeconds: 7 * 24 * 3600,
});

export const catalogSyncDeadLetter = syncDeadLetter;

/**
 * agent.interactive: `exclusive` per run, so a run's job is never queued twice; one active run per thread is
 * the run_active_uq index. A worker that dies is noticed by the heartbeat and the job is retried, which claims the run
 * again (attempt + 1) and resumes from the committed transcript. When retries run out, the dead-letter handler fails
 * the run.
 */
export const agentInteractiveDeadLetter = define<AgentRunJob>("agent.interactive.dlq", {
  policy: "standard",
  retryLimit: 3,
  retryDelay: 5,
  deleteAfterSeconds: 7 * 24 * 3600,
});

export const agentInteractiveQueue = define<AgentRunJob>("agent.interactive", {
  // Someone is waiting: the worker is woken the moment a job is sent (LISTEN/NOTIFY), not at its next poll.
  notify: true,
  policy: "exclusive",
  retryLimit: BUDGETS.agent.retryLimit,
  retryDelay: BUDGETS.agent.retryDelaySeconds,
  retryBackoff: true,
  expireInSeconds: BUDGETS.agent.jobExpireSeconds,
  heartbeatSeconds: BUDGETS.agent.heartbeatSeconds,
  deadLetter: agentInteractiveDeadLetter.name,
  deleteAfterSeconds: 2 * 24 * 3600,
});

/**
 * agent.background: runs nobody is waiting on, apart from the questions' pool: the Investigator's. The
 * same durability as agent.interactive (attempt fence, heartbeat, retries); its dead letter fails the run.
 */
export const agentBackgroundDeadLetter = define<AgentRunJob>("agent.background.dlq", {
  policy: "standard",
  retryLimit: 3,
  retryDelay: 5,
  deleteAfterSeconds: 7 * 24 * 3600,
});

export const agentBackgroundQueue = define<AgentRunJob>("agent.background", {
  policy: "exclusive",
  retryLimit: BUDGETS.agent.retryLimit,
  retryDelay: BUDGETS.agent.retryDelaySeconds,
  retryBackoff: true,
  // Its longest kind is a drafting batch.
  expireInSeconds: BUDGETS.agent.backgroundJobExpireSeconds,
  heartbeatSeconds: BUDGETS.agent.heartbeatSeconds,
  deadLetter: agentBackgroundDeadLetter.name,
  deleteAfterSeconds: 2 * 24 * 3600,
});

/** maint.partitions: no domain row, so its dead-letter handler only raises the alarm (a log line at error level). */
export const maintenanceDeadLetter = define<Record<string, never>>("maint.partitions.dlq", {
  policy: "standard",
  retryLimit: 0,
  deleteAfterSeconds: 7 * 24 * 3600,
});

export const maintenanceQueue = define<Record<string, never>>("maint.partitions", {
  policy: "exclusive",
  retryLimit: 0,
  expireInSeconds: BUDGETS.maintenance.jobExpireSeconds,
  deadLetter: maintenanceDeadLetter.name,
  deleteAfterSeconds: 2 * 24 * 3600,
});

/**
 * system.tick (observability, dispatcher): every minute, once for the deployment. It alarms, never
 * adjudicates. Under a minute to run, never retried (the next tick is the retry); its dead letters are an alert.
 */
export const systemTickDeadLetter = define<Record<string, never>>("system.tick.dlq", {
  policy: "standard",
  retryLimit: 0,
  deleteAfterSeconds: 7 * 24 * 3600,
});

export const systemTickQueue = define<Record<string, never>>("system.tick", {
  policy: "exclusive",
  retryLimit: 0,
  expireInSeconds: BUDGETS.tick.jobExpireSeconds,
  deadLetter: systemTickDeadLetter.name,
  deleteAfterSeconds: 24 * 3600,
});

/** maint.usage: usage_daily from usage_event, for the last 2 days, hourly (idempotent). */
export const usageRollupDeadLetter = define<Record<string, never>>("maint.usage.dlq", {
  policy: "standard",
  retryLimit: 0,
  deleteAfterSeconds: 7 * 24 * 3600,
});

export const usageRollupQueue = define<Record<string, never>>("maint.usage", {
  policy: "exclusive",
  retryLimit: 0,
  expireInSeconds: BUDGETS.maintenance.jobExpireSeconds,
  deadLetter: usageRollupDeadLetter.name,
  deleteAfterSeconds: 2 * 24 * 3600,
});

export const syncScheduleDeadLetter = define<Record<string, never>>("sources.schedule.dlq", {
  policy: "standard",
  retryLimit: 0,
  deleteAfterSeconds: 7 * 24 * 3600,
});

/**
 * sources.schedule: every few minutes, starts the learning runs that are due (sources/schedule.ts). Safe to run
 * twice; a run that dies is picked up by the next one, so the dead-letter queue only reports.
 */
export const syncScheduleQueue = define<Record<string, never>>("sources.schedule", {
  policy: "exclusive",
  retryLimit: 0,
  expireInSeconds: BUDGETS.maintenance.jobExpireSeconds,
  deadLetter: syncScheduleDeadLetter.name,
  deleteAfterSeconds: 2 * 24 * 3600,
});

/** definitions.check: test a source's definitions against its data (semantic/checks.ts). */
export interface DefinitionChecksJob {
  orgId: string;
  connectionId: string;
  /** Test everything again (after a sync: the data moved), not only what changed. */
  all?: boolean;
}

export const definitionChecksDeadLetter = define<DefinitionChecksJob>("definitions.check.dlq", {
  policy: "standard",
  retryLimit: 0,
  deleteAfterSeconds: 7 * 24 * 3600,
});

/**
 * Checks are queries through the gateway, each recorded; running them again only rewrites the results, so a retry
 * is safe. `stately` per source (one queued, one running): a save during a check queues one more check of everything.
 */
export const definitionChecksQueue = define<DefinitionChecksJob>("definitions.check", {
  policy: "stately",
  retryLimit: 2,
  retryDelay: 10,
  expireInSeconds: BUDGETS.catalogSync.jobExpireSeconds,
  deadLetter: definitionChecksDeadLetter.name,
  deleteAfterSeconds: 2 * 24 * 3600,
});

/** embed.batch: an organization's knowledge and tables embedded again where they changed (vectors). */
export interface EmbedBatchJob {
  orgId: string;
}

export const embedBatchDeadLetter = define<EmbedBatchJob>("embed.batch.dlq", {
  policy: "standard",
  retryLimit: 0,
  deleteAfterSeconds: 7 * 24 * 3600,
});

/**
 * embed.batch (vectors): `stately` per organization, so the minute's tick queues at most one behind the one
 * running. A batch only writes what changed, so a retry is safe; two retries, a minute apart and longer, for a
 * provider that's briefly down.
 */
export const embedBatchQueue = define<EmbedBatchJob>("embed.batch", {
  policy: "stately",
  retryLimit: 2,
  retryDelay: 60,
  retryBackoff: true,
  expireInSeconds: BUDGETS.embed.jobExpireSeconds,
  deadLetter: embedBatchDeadLetter.name,
  deleteAfterSeconds: 2 * 24 * 3600,
});

/**
 * dashboard.query: one of a dashboard's named queries, as a page asked for it: bound, compiled and keyed by the web
 * app at this `now`, and bound and compiled again by the worker (which alone opens the source's credentials) from the
 * same revision. Nothing runs when the key no longer matches.
 */
export interface DashboardQueryJob {
  orgId: string;
  dashboardId: string;
  /** The revision the page draws: a saved version's, or its owner's draft's. */
  revision: string;
  /** What the page asked (the query or the drill, its filters, page and sort), as JSON. */
  ask: string;
  /** The period before, for a query that compares. */
  previous?: true;
  cacheKey: string;
  /** The time it was bound at (its freshness bucket's start). */
  now: string;
  /** Who asked: a draft answers its owner alone. */
  askedBy: string | null;
}

/** Its dead letters write a failed answer under the key, so a page asking for it always ends. */
export const dashboardQueryDeadLetter = define<DashboardQueryJob>("dashboard.query.dlq", {
  policy: "standard",
  retryLimit: 3,
  retryDelay: 5,
  deleteAfterSeconds: 7 * 24 * 3600,
});

/**
 * `exclusive` per cache key: one answer is never computed twice at once, however many viewers ask. Every outcome,
 * failure included, is written as the answer, so the job fails only when the worker does; one retry.
 */
export const dashboardQueryQueue = define<DashboardQueryJob>("dashboard.query", {
  // Someone is waiting: the worker is woken the moment a job is sent (LISTEN/NOTIFY), not at its next poll.
  notify: true,
  policy: "exclusive",
  retryLimit: 1,
  retryDelay: 2,
  expireInSeconds: Math.ceil(BUDGETS.gateway.statementMs / 1000) + 60,
  deadLetter: dashboardQueryDeadLetter.name,
  deleteAfterSeconds: 24 * 3600,
});

/** A dashboard's AI summary to write: one at a time per note (its key). */
export interface DashboardSummaryJob {
  orgId: string;
  dashboardId: string;
  revision: string;
  section: string;
  /** The page's filters, as the person had them. */
  filters: Record<string, string | string[]>;
  /** The note's key: the numbers it's written from. */
  noteKey: string;
  /** Who pressed Write: it's read as them and counted to them. */
  askedBy: string;
  /** A rewrite's angle: a fixed instruction, never text from the page. */
  angle?: "lead" | "short" | "email";
}

/** A summary the worker couldn't write after its retries: said, so it doesn't vanish unnoticed. */
export const dashboardSummaryDeadLetter = define<DashboardSummaryJob>("dashboard.summary.dlq", {
  policy: "standard",
  retryLimit: 3,
  retryDelay: 5,
  deleteAfterSeconds: 7 * 24 * 3600,
});

export const dashboardSummaryQueue = define<DashboardSummaryJob>("dashboard.summary", {
  // Someone is waiting: the worker is woken the moment a job is sent (LISTEN/NOTIFY), not at its next poll.
  notify: true,
  policy: "exclusive",
  retryLimit: 1,
  retryDelay: 5,
  expireInSeconds: 180,
  deadLetter: dashboardSummaryDeadLetter.name,
  deleteAfterSeconds: 24 * 3600,
});

/**
 * records.read: the records behind one number (a page of rows and their totals), compiled by the web app with this
 * `now` and these cache keys; the worker resolves the click again and runs both under them.
 */
export interface RecordsReadJob {
  orgId: string;
  /** Who clicked (null for an API key): their access is checked again by the worker. */
  userId: string | null;
  /** The query run of the number clicked. */
  queryRunId: string;
  group?: { time?: string; values?: Record<string, string | number | boolean | null> };
  /** Or the row of the run's result that was clicked. */
  row?: number;
  page: number;
  pageSize: number;
  now: string;
  /** The page's cache key, and its totals'. */
  cacheKey: string;
  summaryKey: string;
}

/** Its dead letters only raise the organization's alert; opening the records again asks again. */
export const recordsReadDeadLetter = define<RecordsReadJob>("records.read.dlq", {
  policy: "standard",
  retryLimit: 0,
  deleteAfterSeconds: 7 * 24 * 3600,
});

/** records.read: exclusive per key, so a page is never read twice at once however many people open it. */
export const recordsReadQueue = define<RecordsReadJob>("records.read", {
  // Someone is waiting: the worker is woken the moment a job is sent (LISTEN/NOTIFY), not at its next poll.
  notify: true,
  policy: "exclusive",
  retryLimit: 1,
  retryDelay: 2,
  expireInSeconds: 2 * Math.ceil(BUDGETS.gateway.statementMs / 1000) + 60,
  deadLetter: recordsReadDeadLetter.name,
  deleteAfterSeconds: 24 * 3600,
});

/** values.read: one column's most common values, read live for a glossary term when someone asks. */
export interface ValuesReadJob {
  orgId: string;
  connectionId: string;
  /** schema.table.column, as in the catalog. */
  column: string;
  cacheKey: string;
  /** Who asked: recorded on the query run. */
  requestedBy: string | null;
  now: string;
}

/** Its dead letters only raise the organization's alert (a worker died on the read): asking again queues it again. */
export const valuesReadDeadLetter = define<ValuesReadJob>("values.read.dlq", {
  policy: "standard",
  retryLimit: 0,
  deleteAfterSeconds: 7 * 24 * 3600,
});

/**
 * `exclusive` per cache key: one read per column per freshness bucket, however many ask. Nothing waits on it beyond a
 * page polling for a few seconds, so no retry.
 */
export const valuesReadQueue = define<ValuesReadJob>("values.read", {
  // Someone is waiting: the worker is woken the moment a job is sent (LISTEN/NOTIFY), not at its next poll.
  notify: true,
  policy: "exclusive",
  retryLimit: 0,
  deadLetter: valuesReadDeadLetter.name,
  expireInSeconds: Math.ceil(BUDGETS.gateway.statementMs / 1000) + 60,
  deleteAfterSeconds: 24 * 3600,
});

/** metric.check: reads and judges one watched metric for its last whole week or month. */
export interface MetricCheckJob {
  orgId: string;
  checkId: string;
}

export const metricCheckDeadLetter = define<MetricCheckJob>("metric.check.dlq", {
  policy: "standard",
  // Its handler fails the domain row; a transient error there is tried again, as the agent dead letters are.
  retryLimit: 3,
  retryDelay: 5,
  deleteAfterSeconds: 7 * 24 * 3600,
});

/** One at a time per check (`exclusive` by its id): one query, then the detectors; one retry. */
export const metricCheckQueue = define<MetricCheckJob>("metric.check", {
  policy: "exclusive",
  retryLimit: 1,
  retryDelay: 30,
  expireInSeconds: Math.ceil(BUDGETS.gateway.statementMs / 1000) + 60,
  deadLetter: metricCheckDeadLetter.name,
  deleteAfterSeconds: 24 * 3600,
});

/** outcome.check: checks one done task's outcome against its metric's prior trend. */
export interface OutcomeCheckJob {
  orgId: string;
  todoId: string;
}

export const outcomeCheckDeadLetter = define<OutcomeCheckJob>("outcome.check.dlq", {
  policy: "standard",
  retryLimit: 0,
  deleteAfterSeconds: 7 * 24 * 3600,
});

export const outcomeCheckQueue = define<OutcomeCheckJob>("outcome.check", {
  policy: "exclusive",
  retryLimit: 1,
  retryDelay: 30,
  expireInSeconds: Math.ceil(BUDGETS.gateway.statementMs / 1000) + 60,
  deadLetter: outcomeCheckDeadLetter.name,
  deleteAfterSeconds: 24 * 3600,
});

/** effect.send: sends one outbox row (an email, or a post to a Slack channel). */
export interface EffectSendJob {
  orgId: string;
  effectId: string;
}

export const effectSendDeadLetter = define<EffectSendJob>("effect.send.dlq", {
  policy: "standard",
  // Its handler fails the domain row; a transient error there is tried again, as the agent dead letters are.
  retryLimit: 3,
  retryDelay: 5,
  deleteAfterSeconds: 7 * 24 * 3600,
});

/** One send per row (`exclusive` by its id); two retries a minute apart, only of sends that surely didn't go. */
export const effectSendQueue = define<EffectSendJob>("effect.send", {
  policy: "exclusive",
  retryLimit: 2,
  retryDelay: 60,
  expireInSeconds: BUDGETS.delivery.jobExpireSeconds,
  deadLetter: effectSendDeadLetter.name,
  deleteAfterSeconds: 24 * 3600,
});

/** routine.run: one run of a routine: what it sends, made and handed to the outbox. */
export interface RoutineRunJob {
  orgId: string;
  routineRunId: string;
}

export const routineRunDeadLetter = define<RoutineRunJob>("routine.run.dlq", {
  policy: "standard",
  // Its handler fails the domain row; a transient error there is tried again, as the agent dead letters are.
  retryLimit: 3,
  retryDelay: 5,
  deleteAfterSeconds: 7 * 24 * 3600,
});

/** One at a time per run (`exclusive` by its id): its question handed to the analyst, or its digest made; one retry. */
export const routineRunQueue = define<RoutineRunJob>("routine.run", {
  policy: "exclusive",
  retryLimit: 1,
  retryDelay: 60,
  expireInSeconds: Math.ceil((BUDGETS.gateway.statementMs * 12) / 1000) + 60,
  deadLetter: routineRunDeadLetter.name,
  deleteAfterSeconds: 24 * 3600,
});

/** eval.run: starts one run of an organization's evals (evals/run.ts): syncs its cases and queues one job each. */
export interface EvalRunJob {
  orgId: string;
  evalRunId: string;
}

/** eval.case: one case of a run, asked of the analyst and graded. */
export interface EvalCaseJob {
  orgId: string;
  evalRunId: string;
  caseId: string;
}

export const evalRunDeadLetter = define<EvalRunJob>("eval.run.dlq", {
  policy: "standard",
  retryLimit: 3,
  retryDelay: 5,
  deleteAfterSeconds: 7 * 24 * 3600,
});

/** eval.run: a start that fails for good is dead-lettered, and the run marked failed (it would block the next). */
export const evalRunQueue = define<EvalRunJob>("eval.run", {
  policy: "exclusive",
  retryLimit: 2,
  retryDelay: 10,
  expireInSeconds: BUDGETS.maintenance.jobExpireSeconds,
  deadLetter: evalRunDeadLetter.name,
  deleteAfterSeconds: 2 * 24 * 3600,
});

export const evalCaseDeadLetter = define<EvalCaseJob>("eval.case.dlq", {
  policy: "standard",
  retryLimit: 3,
  retryDelay: 5,
  deleteAfterSeconds: 7 * 24 * 3600,
});

/**
 * eval.case: an analyst run each, so the agent's budgets: a case that dies or hangs is dead-lettered into an error
 * result and the run still finishes. `exclusive` per run and case, so a case is never asked twice at once.
 */
export const evalCaseQueue = define<EvalCaseJob>("eval.case", {
  policy: "exclusive",
  retryLimit: 1,
  retryDelay: BUDGETS.agent.retryDelaySeconds,
  expireInSeconds: BUDGETS.agent.jobExpireSeconds,
  heartbeatSeconds: BUDGETS.agent.heartbeatSeconds,
  deadLetter: evalCaseDeadLetter.name,
  deleteAfterSeconds: 2 * 24 * 3600,
});

export const evalScheduleDeadLetter = define<Record<string, never>>("eval.schedule.dlq", {
  policy: "standard",
  retryLimit: 0,
  deleteAfterSeconds: 7 * 24 * 3600,
});

/** eval.schedule: at 03:00 UTC, a run for each organization that turned nightly evals on. */
export const evalScheduleQueue = define<Record<string, never>>("eval.schedule", {
  policy: "exclusive",
  retryLimit: 0,
  expireInSeconds: BUDGETS.maintenance.jobExpireSeconds,
  deadLetter: evalScheduleDeadLetter.name,
  deleteAfterSeconds: 2 * 24 * 3600,
});

/**
 * ai_provider.test: a provider's credentials, tested, and what it can run read from its own list. A
 * daily refresh (`refresh`) is the same job: it only updates the list, and a provider that can't be reached keeps
 * working on what it listed last.
 */
export interface AiProviderTestJob {
  orgId: string;
  kind: ProviderKind;
  /** The credentials tested: a provider whose credentials were replaced since the job was queued isn't touched. */
  secretId: string;
  /** Credentials not saved yet (ai_provider_test): the result goes on the test, for Set up to take. */
  testId?: string;
  refresh?: boolean;
}

export const aiProviderTestDeadLetter = define<AiProviderTestJob>("ai_provider.test.dlq", {
  policy: "standard",
  retryLimit: 3,
  retryDelay: 5,
  deleteAfterSeconds: 7 * 24 * 3600,
});

/**
 * A failed test is a result (the provider's status), not a job failure; a dead worker's job is dead-lettered. One
 * waiting per key: the same credentials' test, or the same day's refresh, is never queued twice.
 */
export const aiProviderTestQueue = define<AiProviderTestJob>("ai_provider.test", {
  // Someone is waiting: the worker is woken the moment a job is sent (LISTEN/NOTIFY), not at its next poll.
  notify: true,
  policy: "stately",
  retryLimit: 0,
  expireInSeconds: BUDGETS.aiProviderTest.jobExpireSeconds,
  deadLetter: aiProviderTestDeadLetter.name,
  deleteAfterSeconds: 24 * 3600,
});

export const aiProviderRefreshDeadLetter = define<Record<string, never>>("ai_provider.refresh.dlq", {
  policy: "standard",
  retryLimit: 0,
  deleteAfterSeconds: 7 * 24 * 3600,
});

/** ai_provider.refresh: at 04:41 UTC, a refresh queued for every working provider that has a list of its own. */
export const aiProviderRefreshQueue = define<Record<string, never>>("ai_provider.refresh", {
  policy: "exclusive",
  retryLimit: 0,
  expireInSeconds: BUDGETS.maintenance.jobExpireSeconds,
  deadLetter: aiProviderRefreshDeadLetter.name,
  deleteAfterSeconds: 2 * 24 * 3600,
});

/**
 * slack.reply: one run's reply in Slack, streamed from its events. Ids only: the Slack thread it goes to is
 * in app.slack_reply, never in the job. Exclusive by run; its row fences each attempt and records each part, so a
 * retry never posts twice. It lives as long as the run may (a run's own limit, plus a minute). Retries
 * are many because a hand-off at a shutdown uses one too; the row counts the real failures, and gives up at three.
 */
export interface SlackReplyJob {
  orgId: string;
  runId: string;
}

export const slackReplyDeadLetter = define<SlackReplyJob>("slack.reply.dlq", {
  policy: "standard",
  // Its handler settles the domain row; a transient error there is tried again, as the agent dead letters are.
  retryLimit: 3,
  retryDelay: 5,
  deleteAfterSeconds: 7 * 24 * 3600,
});

export const slackReplyQueue = define<SlackReplyJob>("slack.reply", {
  policy: "exclusive",
  retryLimit: 20,
  retryDelay: 10,
  expireInSeconds: BUDGETS.agent.jobExpireSeconds + 60,
  heartbeatSeconds: BUDGETS.agent.heartbeatSeconds,
  deadLetter: slackReplyDeadLetter.name,
  deleteAfterSeconds: 2 * 24 * 3600,
});

/**
 * slack.files: a file under a Slack answer, asked for from its Download menu (the answer as a PDF, or a cited query's
 * rows as CSV), posted in its thread. Ids only: where it goes is the reply's row. Tried once: a retry after the file
 * went would send it twice, and the menu is there to ask again.
 */
export interface SlackFilesJob {
  orgId: string;
  runId: string;
  /** The answer as a PDF, or the rows of one query it cites (its query run). */
  file: "pdf" | `csv:${string}`;
}

export const slackFilesDeadLetter = define<SlackFilesJob>("slack.files.dlq", {
  policy: "standard",
  retryLimit: 0,
  deleteAfterSeconds: 7 * 24 * 3600,
});

export const slackFilesQueue = define<SlackFilesJob>("slack.files", {
  policy: "standard",
  retryLimit: 0,
  expireInSeconds: 300,
  deadLetter: slackFilesDeadLetter.name,
  deleteAfterSeconds: 2 * 24 * 3600,
});

/**
 * slack.inbound.check: every minute, the questions from Slack nothing handled in time, handed to the bot
 * again (or, past their last try, the person told). One at a time; a missed minute is caught up by the next.
 */
export const slackInboundDeadLetter = define<Record<string, never>>("slack.inbound.check.dlq", {
  policy: "standard",
  retryLimit: 0,
  deleteAfterSeconds: 7 * 24 * 3600,
});

export const slackInboundQueue = define<Record<string, never>>("slack.inbound.check", {
  policy: "exclusive",
  retryLimit: 0,
  expireInSeconds: BUDGETS.dispatch.jobExpireSeconds,
  deadLetter: slackInboundDeadLetter.name,
  deleteAfterSeconds: 24 * 3600,
});

/**
 * learning.dispatch: every minute, the Curator started on corrections waiting for it, and a learning a new
 * correction joined decided again. One at a time; a missed minute is caught up by the next.
 */
export const learningDispatchDeadLetter = define<Record<string, never>>("learning.dispatch.dlq", {
  policy: "standard",
  retryLimit: 0,
  deleteAfterSeconds: 7 * 24 * 3600,
});

export const learningDispatchQueue = define<Record<string, never>>("learning.dispatch", {
  policy: "exclusive",
  retryLimit: 0,
  expireInSeconds: BUDGETS.dispatch.jobExpireSeconds,
  deadLetter: learningDispatchDeadLetter.name,
  deleteAfterSeconds: 24 * 3600,
});

export interface LearningEvaluateJob {
  orgId: string;
  proposalId: string;
}

/**
 * learning.evaluate: a proposed term checked on the data, tested by one analyst run given it (so the
 * agent's budgets), graded on what its queries read, then decided. One a proposal.
 */
export const learningEvaluateDeadLetter = define<LearningEvaluateJob>("learning.evaluate.dlq", {
  policy: "standard",
  // Its handler settles the domain row; a transient error there is tried again, as the agent dead letters are.
  retryLimit: 3,
  retryDelay: 5,
  deleteAfterSeconds: 7 * 24 * 3600,
});

export const learningEvaluateQueue = define<LearningEvaluateJob>("learning.evaluate", {
  policy: "exclusive",
  retryLimit: 1,
  retryDelay: BUDGETS.agent.retryDelaySeconds,
  expireInSeconds: BUDGETS.agent.jobExpireSeconds,
  heartbeatSeconds: BUDGETS.agent.heartbeatSeconds,
  deadLetter: learningEvaluateDeadLetter.name,
  deleteAfterSeconds: 2 * 24 * 3600,
});

/**
 * graph.dispatch: every minute, each organization whose knowledge changed since its graph was last
 * projected (or with a learning under way) gets a graph.project job. One at a time; a missed minute is caught up.
 */
export const graphDispatchDeadLetter = define<Record<string, never>>("graph.dispatch.dlq", {
  policy: "standard",
  retryLimit: 0,
  deleteAfterSeconds: 7 * 24 * 3600,
});

export const graphDispatchQueue = define<Record<string, never>>("graph.dispatch", {
  policy: "exclusive",
  retryLimit: 0,
  expireInSeconds: BUDGETS.dispatch.jobExpireSeconds,
  deadLetter: graphDispatchDeadLetter.name,
  deleteAfterSeconds: 24 * 3600,
});

export interface GraphProjectJob {
  orgId: string;
}

/** graph.project: one organization's nodes and edges rebuilt whole, in one transaction. One an org. */
export const graphProjectDeadLetter = define<GraphProjectJob>("graph.project.dlq", {
  policy: "standard",
  retryLimit: 0,
  deleteAfterSeconds: 7 * 24 * 3600,
});

export const graphProjectQueue = define<GraphProjectJob>("graph.project", {
  policy: "exclusive",
  retryLimit: 2,
  retryDelay: 30,
  expireInSeconds: BUDGETS.dispatch.graphProjectExpireSeconds,
  deadLetter: graphProjectDeadLetter.name,
  deleteAfterSeconds: 24 * 3600,
});

/** In creation order: a dead-letter queue must exist before the queue that points at it. */
export const QUEUES: QueueDefinition<unknown>[] = [
  connectionTestDeadLetter,
  connectionTestQueue,
  catalogSyncDeadLetter,
  catalogSyncQueue,
  catalogHistoryQueue,
  agentInteractiveDeadLetter,
  agentInteractiveQueue,
  agentBackgroundDeadLetter,
  agentBackgroundQueue,
  maintenanceDeadLetter,
  maintenanceQueue,
  syncScheduleDeadLetter,
  syncScheduleQueue,
  definitionChecksDeadLetter,
  definitionChecksQueue,
  dashboardQueryDeadLetter,
  dashboardQueryQueue,
  dashboardSummaryDeadLetter,
  dashboardSummaryQueue,
  valuesReadDeadLetter,
  valuesReadQueue,
  recordsReadDeadLetter,
  recordsReadQueue,
  metricCheckDeadLetter,
  metricCheckQueue,
  outcomeCheckDeadLetter,
  outcomeCheckQueue,
  effectSendDeadLetter,
  effectSendQueue,
  routineRunDeadLetter,
  routineRunQueue,
  evalRunDeadLetter,
  evalRunQueue,
  evalCaseDeadLetter,
  evalCaseQueue,
  evalScheduleDeadLetter,
  evalScheduleQueue,
  aiProviderTestDeadLetter,
  aiProviderTestQueue,
  aiProviderRefreshDeadLetter,
  aiProviderRefreshQueue,
  systemTickDeadLetter,
  systemTickQueue,
  usageRollupDeadLetter,
  usageRollupQueue,
  slackReplyDeadLetter,
  slackReplyQueue,
  slackFilesDeadLetter,
  slackFilesQueue,
  slackInboundDeadLetter,
  slackInboundQueue,
  learningDispatchDeadLetter,
  learningDispatchQueue,
  learningEvaluateDeadLetter,
  learningEvaluateQueue,
  graphDispatchDeadLetter,
  graphDispatchQueue,
  graphProjectDeadLetter,
  graphProjectQueue,
  embedBatchDeadLetter,
  embedBatchQueue,
];

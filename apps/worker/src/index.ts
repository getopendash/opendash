/**
 * Worker entry point. One image, pools chosen with WORKER_POOLS:
 * a self-host runs every pool in one process. Pools land with their epics; today the query pool tests connections, the
 * sync pool learns sources (catalog.sync, then catalog.history) and tests definitions (definitions.check), the interactive pool answers questions
 * (agent.interactive), and every worker keeps the partitions ahead (maint.partitions).
 *
 * Rules: pg-boss is the only liveness authority, it gets its own pool, every handler is bounded by the
 * job's AbortSignal, and an unhandled rejection crashes the process so pg-boss retries instead of the worker limping.
 */
import os from "node:os";
import path from "node:path";
import {
  type AttemptResult,
  checkProvider,
  createEmbedderResolver,
  createModelResolver,
  runAttempt,
  writeSummary,
} from "@opendash/agent";
import {
  type AgentRunJob,
  type AiProviderTestJob,
  type AnswerOutcome,
  agentBackgroundDeadLetter,
  agentBackgroundQueue,
  agentInteractiveDeadLetter,
  agentInteractiveQueue,
  aiProviderRefreshDeadLetter,
  aiProviderRefreshQueue,
  aiProviderTestDeadLetter,
  aiProviderTestQueue,
  auditRetentionDays,
  BUDGETS,
  beginEvalRun,
  type CatalogSyncJob,
  type ConnectionTestJob,
  catalogHistoryQueue,
  catalogSyncDeadLetter,
  catalogSyncQueue,
  checkDefinitions,
  checkFailed,
  checkOutcome,
  connectionTestDeadLetter,
  connectionTestQueue,
  createBoss,
  createSecretStore,
  type DashboardQueryJob,
  type DashboardSummaryJob,
  type DefinitionChecksJob,
  dashboardQueryDeadLetter,
  dashboardQueryQueue,
  dashboardSummaryDeadLetter,
  dashboardSummaryQueue,
  dashboards,
  deadLettered,
  definitionChecksDeadLetter,
  definitionChecksQueue,
  deliverEffect,
  deploymentKeys,
  dispatchNightlyEvals,
  dispatchProviderRefresh,
  dispatchScheduledSyncs,
  dropUnusedPrompts,
  type EffectSendJob,
  type EmbedBatchJob,
  type EvalAsk,
  type EvalCaseJob,
  EvalHandedOff,
  type EvalRunJob,
  effectFailed,
  effectSendDeadLetter,
  effectSendQueue,
  embedBatchDeadLetter,
  embedBatchQueue,
  embedOrganization,
  evalCaseDeadLetter,
  evalCaseQueue,
  evalRunDeadLetter,
  evalRunQueue,
  evalScheduleDeadLetter,
  evalScheduleQueue,
  executeCommonValues,
  executeEvalCase,
  executeRecords,
  failEvalCase,
  failEvalRun,
  failProviderTest,
  failRunFromQueue,
  failStaleQueuedRuns,
  finishAgentRun,
  getRun,
  installQueues,
  investigationStarted,
  kekFromEnv,
  learnPickedMeanwhile,
  loggableError,
  loggableStack,
  logger,
  type MetricCheckJob,
  maintainPartitions,
  maintenanceDeadLetter,
  maintenanceQueue,
  markChecked,
  type mcp,
  metricCheckDeadLetter,
  metricCheckQueue,
  nextDraftBatchAfter,
  type OutcomeCheckJob,
  outcomeCheckDeadLetter,
  outcomeCheckQueue,
  partitionsChecked,
  proposeMissingStarterPacks,
  proposeStarterPack,
  purgeDeletedOrgs,
  purgeSlackInbound,
  purgeSlackInstalls,
  purgeSlackLinks,
  queueDueChecks,
  queueDueOutcomeChecks,
  queueDueRoutines,
  queueStaleEmbeddings,
  type RecordsReadJob,
  type RoutineRunJob,
  recordsReadDeadLetter,
  recordsReadQueue,
  refreshDefinitionChecks,
  releaseDueRuns,
  requestNextDraftBatch,
  resumeHeldDrafts,
  rollupUsage,
  routineRunDeadLetter,
  routineRunFailed,
  routineRunQueue,
  runCatalogSync,
  runCheck,
  runConnectionTest,
  runProfileOf,
  runRoutineRun,
  runSyncHistory,
  settleConnectionTest,
  settleInvestigation,
  settleLearning,
  settleProposal,
  settleSync,
  slackPoster,
  submitQuestion,
  syncScheduleDeadLetter,
  syncScheduleQueue,
  systemTick,
  systemTickDeadLetter,
  systemTickQueue,
  testProvider,
  trackServerError,
  unsubscribeToken,
  usageRollupDeadLetter,
  usageRollupQueue,
  type ValuesReadJob,
  valuesReadDeadLetter,
  valuesReadQueue,
  warnSpend,
  workDraining,
} from "@opendash/core";
import { closeDatabases, withSystem, withTenant } from "@opendash/db";
import { emailLinkOrigin, emailSenderFromEnv, isUndeliverable, routineEmail } from "@opendash/email";
import { routineBlocks } from "@opendash/slack";
import { loadRootEnv } from "../../../scripts/load-env.mjs";
import { enterprise } from "./enterprise";
import { startGraph } from "./graph";
import { startLearning } from "./learning";
import { rebuildUnmarkedBundles } from "./rebuild-bundles";
import { startSlack } from "./slack";
import { startTelemetry } from "./telemetry";

loadRootEnv(path.resolve(import.meta.dirname, "../../.."));
// Traces, when an OTLP endpoint is set; before anything that makes spans.
const telemetry = startTelemetry();

const out = logger.with({ service: "worker" });
const log = (msg: string, fields: Record<string, unknown> = {}) => out.info(msg, fields);

process.on("unhandledRejection", (reason) => {
  // The database's own words and where it was thrown, never a failed query's SQL or parameters (loggable.ts).
  out.error("unhandled rejection, exiting", { reason: loggableError(reason), stack: loggableStack(reason) });
  // Reported where product analytics is on (its type and frames, never its message), waited on only as long as one
  // send may take; then the process ends as before.
  void trackServerError({
    error: reason,
    kind: "unhandled_rejection",
    service: "worker",
    mechanism: "onunhandledrejection",
  }).finally(() => process.exit(1));
});

const pools = new Set((process.env.WORKER_POOLS ?? "all").split(",").map((pool) => pool.trim()));
const runs = (pool: string) => pools.has("all") || pools.has(pool);

const queueUrl = process.env.DATABASE_QUEUE_URL;
if (!queueUrl) throw new Error("Set DATABASE_QUEUE_URL (opendash_queue, direct or session-mode connection).");
const edition: "cloud" | "community" = process.env.OPENDASH_EDITION === "cloud" ? "cloud" : "community";

const kek = kekFromEnv();
const secrets = createSecretStore({ kek });
const tenantDeps = {
  withTenant: <T>(orgId: string, fn: Parameters<typeof withTenant<T>>[1]) => withTenant({ orgId }, fn),
};
/** For alerts and the dispatcher: the system role, and the worker's log. */
const ops = { withSystem, log: out };
/** An organization's embedder (vectors): its OpenAI key or the deployment's, or none (search by words). */
const embedder = createEmbedderResolver({ ...tenantDeps, secrets });

const boss = createBoss(queueUrl, "worker");
/** Raised on SIGTERM, before pg-boss stops: agent runs hand off at their next step boundary. */
const drain = new AbortController();
/** Agent attempts in this process, so a shutdown waits for any pg-boss's grace cut off to finish unwinding. */
const attempts = new Set<Promise<unknown>>();
const tracked = <T>(attempt: Promise<T>): Promise<T> => {
  attempts.add(attempt);
  attempt.then(
    () => attempts.delete(attempt),
    () => attempts.delete(attempt),
  );
  return attempt;
};
await boss.start();
await installQueues(boss);

if (runs("query")) {
  // Probes are network-bound and short; a handful at once per process is plenty.
  await boss.work<ConnectionTestJob>(connectionTestQueue.name, { localConcurrency: 4 }, async ([job]) => {
    if (!job) return;
    const status = await runConnectionTest({ ...tenantDeps, secrets, edition }, job.data, job.signal);
    log("connection test", { testId: job.data.testId, status });
  });
  await boss.work<ConnectionTestJob>(connectionTestDeadLetter.name, async ([job]) => {
    if (!job) return;
    const settled = await settleConnectionTest(tenantDeps, job.data, "failed", {
      message: "The check didn't finish. Try again.",
    });
    await deadLettered(ops, {
      queue: connectionTestDeadLetter.name,
      orgId: job.data.orgId,
      message:
        "It was marked failed. Test the source again; if it keeps happening, the source may be unreachable from OpenDash.",
      detail: { testId: job.data.testId, settled },
    });
  });
  // A dashboard's queries (dashboard.query): the gateway caps concurrent queries per source on top of this. The job's
  // signal reaches the warehouse: a job that expires cancels its query, so a retry never runs beside it. Its slots drain
  // the queue (workDraining): a page's queries beyond the 8 start as slots free, not at the next poll.
  await workDraining(boss, dashboardQueryQueue, { slots: 8, includeMetadata: true }, async ([job]) => {
    if (!job) return;
    // A service a dashboard reads (MCP) is read as its owner, in a transaction that carries them.
    const origin = emailLinkOrigin();
    // Each stage's milliseconds, kept as the job's output: where an answer's time went.
    const stages: Record<string, number> = {};
    const started = performance.now();
    const done = await dashboards.executeDashboardQuery(
      {
        ...tenantDeps,
        stages,
        secrets,
        edition,
        withUser: (orgId, userId, fn) => withTenant({ orgId, userId }, fn),
        ...(origin
          ? {
              mcp: {
                secrets,
                edition,
                withTenant: (ctx, fn) => withTenant(ctx, fn),
                redirectUrl: `${origin}/api/mcp/callback`,
                clientName: "OpenDash",
              } satisfies mcp.McpDeps,
            }
          : {}),
      },
      job.data,
      job.signal,
    );
    // queued: how long it waited in line for a slot once it could start (a retry from its delayed start, so a first try
    // and its back-off aren't counted); slot (in stages): how long it waited for one of its source's places.
    const ready = Math.max(job.createdOn.getTime(), job.startAfter.getTime());
    const queued = Math.max(0, job.startedOn.getTime() - ready);
    const ms = { queued, ...stages, total: Math.round(performance.now() - started) };
    log("dashboard query", { dashboardId: job.data.dashboardId, done, ms, retry: job.retryCount });
    return { done, ms };
  });
  await boss.work<DashboardQueryJob>(dashboardQueryDeadLetter.name, async ([job]) => {
    if (!job) return;
    await dashboards.dashboardQueryFailed(tenantDeps, job.data);
    await deadLettered(ops, {
      queue: dashboardQueryDeadLetter.name,
      orgId: job.data.orgId,
      message: "A dashboard's query stopped the worker twice. Its page says so; opening it again asks again.",
      detail: { dashboardId: job.data.dashboardId },
    });
  });
  // A glossary term's column values, read when someone asks (none are kept).
  await workDraining(boss, valuesReadQueue, { slots: 4 }, async ([job]) => {
    if (!job) return;
    const read = await executeCommonValues({ ...tenantDeps, secrets, edition }, job.data);
    log("column values", { connectionId: job.data.connectionId, read });
  });
  // The records behind a number, read when someone opens them (none are kept beyond the query run).
  await workDraining(boss, recordsReadQueue, { slots: 4 }, async ([job]) => {
    if (!job) return;
    const read = await executeRecords({ ...tenantDeps, secrets, edition }, job.data, job.signal);
    log("records", { queryRunId: job.data.queryRunId, read });
  });
  await boss.work<RecordsReadJob>(recordsReadDeadLetter.name, async ([job]) => {
    if (!job) return;
    await deadLettered(ops, {
      queue: recordsReadDeadLetter.name,
      orgId: job.data.orgId,
      message: "Reading a number's records stopped the worker. Opening them again asks for them again.",
      detail: { queryRunId: job.data.queryRunId },
    });
  });
  await boss.work<ValuesReadJob>(valuesReadDeadLetter.name, async ([job]) => {
    if (!job) return;
    await deadLettered(ops, {
      queue: valuesReadDeadLetter.name,
      orgId: job.data.orgId,
      message: "Reading a column's values stopped the worker. Showing them again asks for them again.",
      detail: { connectionId: job.data.connectionId, column: job.data.column },
    });
  });
  // A metric check: one watched metric read once for its last whole week or month, however many routines
  // watch it; what it files for the first time is told to the routines it meets, in the same transaction.
  await boss.work<MetricCheckJob>(metricCheckQueue.name, { localConcurrency: 2 }, async ([job]) => {
    if (!job) return;
    const out = await runCheck({ ...tenantDeps, secrets, edition, boss, deploymentKeys: deploymentKeys() }, job.data);
    log("metric checked", {
      checkId: job.data.checkId,
      status: out.status,
      found: out.found.length,
      filed: out.filed.length,
      runs: out.runs,
    });
  });
  await boss.work<MetricCheckJob>(metricCheckDeadLetter.name, async ([job]) => {
    if (!job) return;
    await checkFailed(tenantDeps, job.data);
    await deadLettered(ops, {
      queue: metricCheckDeadLetter.name,
      orgId: job.data.orgId,
      message: "A metric check stopped the worker twice. It's marked failed and tries again the next morning.",
      detail: { checkId: job.data.checkId },
    });
  });
  // One outbox row sent: a routine's email, through Resend or SMTP when configured, or its post in a Slack channel,
  // with the workspace's own bot token (whatever this process's Slack events do). Links go to the web app; in
  // production without its HTTPS origin, nothing is sent rather than a link to the wrong place.
  const webUrl = emailLinkOrigin();
  if (!webUrl) log("email off: set BETTER_AUTH_URL to the web app's https origin to send routines' emails");
  const sender = webUrl
    ? emailSenderFromEnv(process.env, {
        smtpTimeouts: { connectMs: BUDGETS.email.smtpConnectMs, socketMs: BUDGETS.email.smtpSocketMs },
      })
    : null;
  const slackOut = webUrl ? { render: routineBlocks, post: slackPoster({ ...tenantDeps, secrets }) } : null;
  await boss.work<EffectSendJob>(effectSendQueue.name, async ([job]) => {
    if (!job) return;
    const out = await deliverEffect({ ...tenantDeps, boss }, job.data, {
      sender,
      slack: slackOut,
      render: routineEmail,
      baseUrl: webUrl ?? "",
      canDeliver: (email) => !isUndeliverable(email),
      // One-click unsubscribe: links signed with a key from the auth secret, which the web app shares.
      unsubscribe: (target) => {
        const secret = process.env.BETTER_AUTH_SECRET;
        if (!secret || !webUrl) return null;
        const t = encodeURIComponent(unsubscribeToken(secret, target));
        return { page: `${webUrl}/unsubscribe?t=${t}`, oneClick: `${webUrl}/api/unsubscribe?t=${t}` };
      },
    });
    log("effect delivered", { effectId: job.data.effectId, status: out });
  });
  await boss.work<EffectSendJob>(effectSendDeadLetter.name, async ([job]) => {
    if (!job) return;
    await effectFailed({ ...tenantDeps, boss }, job.data);
    await deadLettered(ops, {
      queue: effectSendDeadLetter.name,
      orgId: job.data.orgId,
      message: "A routine's email or Slack post couldn't be sent after three tries. Its outbox row says failed.",
      detail: { effectId: job.data.effectId },
    });
  });
  // A routine's run: a dashboard's tiles re-run and snapshotted, a summary's figures read and its written
  // part queued, a question queued for the Analyst, or findings told; what it makes goes to the outbox.
  await boss.work<RoutineRunJob>(routineRunQueue.name, { localConcurrency: 2 }, async ([job]) => {
    if (!job) return;
    const status = await runRoutineRun(
      { ...tenantDeps, secrets, edition, boss, deploymentKeys: deploymentKeys() },
      job.data,
    );
    log("routine run", { routineRunId: job.data.routineRunId, status });
  });
  await boss.work<RoutineRunJob>(routineRunDeadLetter.name, async ([job]) => {
    if (!job) return;
    await routineRunFailed({ ...tenantDeps, boss }, job.data);
    await deadLettered(ops, {
      queue: routineRunDeadLetter.name,
      orgId: job.data.orgId,
      message: "A routine's run couldn't finish, twice. It's marked failed; the routine runs again at its next time.",
      detail: { routineRunId: job.data.routineRunId },
    });
  });
  // Tasks v0: a done task's outcome, its metric's months against its prior trend (no model involved).
  await boss.work<OutcomeCheckJob>(outcomeCheckQueue.name, async ([job]) => {
    if (!job) return;
    const out = await checkOutcome({ ...tenantDeps, secrets, edition }, job.data);
    log("outcome checked", { todoId: job.data.todoId, status: out.status, verdict: out.verdict ?? null });
  });
  await boss.work<OutcomeCheckJob>(outcomeCheckDeadLetter.name, async ([job]) => {
    if (!job) return;
    await deadLettered(ops, {
      queue: outcomeCheckDeadLetter.name,
      orgId: job.data.orgId,
      message: "A task's outcome check stopped the worker twice. It runs again tomorrow.",
      detail: { todoId: job.data.todoId },
    });
  });
}

if (runs("sync")) {
  const syncDeps = { ...tenantDeps, boss, secrets, edition } as const;
  // Scheduled learning (sources/schedule.ts): every 5 minutes, start the runs that are due.
  await boss.work(syncScheduleQueue.name, async () => {
    const done = await dispatchScheduledSyncs({ withSystem, withTenant: tenantDeps.withTenant, boss });
    if (done.started) log("scheduled syncs", done);
    // Sample sources learned before starter packs existed get theirs here.
    const packs = await proposeMissingStarterPacks({ withSystem, withTenant: tenantDeps.withTenant, boss });
    if (packs) log("starter packs proposed", { sources: packs });
    // Batches held for the background budget start once it has room.
    try {
      const held = await resumeHeldDrafts({
        withSystem,
        withTenant: tenantDeps.withTenant,
        boss,
        deploymentKeys: deploymentKeys(),
      });
      if (held.resumed) log("held drafts resumed", held);
    } catch (error) {
      log("resuming held drafts failed", { error: (error as Error).name });
    }
  });
  await boss.work(syncScheduleDeadLetter.name, async () => {
    await deadLettered(ops, {
      queue: syncScheduleDeadLetter.name,
      message: "Dispatching scheduled syncs failed; the next dispatch picks up what's due.",
    });
  });
  await boss.schedule(syncScheduleQueue.name, "*/5 * * * *");
  // One source at a time per worker: profiling is many short queries against the customer's database.
  await boss.work<CatalogSyncJob>(catalogSyncQueue.name, { localConcurrency: 2 }, async ([job]) => {
    if (!job) return;
    const status = await runCatalogSync(syncDeps, job.data, job.signal);
    log("catalog sync", { syncRunId: job.data.syncRunId, status });
  });
  await boss.work<CatalogSyncJob>(catalogHistoryQueue.name, { localConcurrency: 2 }, async ([job]) => {
    if (!job) return;
    const status = await runSyncHistory(syncDeps, job.data, job.signal);
    log("sync history", { syncRunId: job.data.syncRunId, status });
    // A sample source learned for the first time gets its starter pack proposed, and the pack's checks queued.
    if (status === "succeeded") {
      // Tables its admin picked while this sync was profiling: one more sync learns them.
      const again = await learnPickedMeanwhile({ ...tenantDeps, boss }, job.data);
      if (again) log("learning the picked tables", { connectionId: job.data.connectionId, syncRunId: again });
      // Automatic drafting: the next batch of learned tables, once nothing more is to learn first.
      if (!again) {
        try {
          const batch = await requestNextDraftBatch(
            { ...tenantDeps, boss, deploymentKeys: deploymentKeys() },
            job.data,
          );
          if (batch) log("drafting automatically", { connectionId: job.data.connectionId, ...batch });
        } catch (error) {
          log("automatic drafting failed", { connectionId: job.data.connectionId, error: (error as Error).name });
        }
      }
      const proposed = await tenantDeps.withTenant(job.data.orgId, (tx) =>
        proposeStarterPack({ boss }, tx, { orgId: job.data.orgId, connectionId: job.data.connectionId }),
      );
      if (proposed) log("starter pack proposed", { connectionId: job.data.connectionId, proposed });
      else {
        // The data moved: test the source's definitions again, for their latest values.
        await tenantDeps.withTenant(job.data.orgId, (tx) =>
          refreshDefinitionChecks({ boss }, tx, { orgId: job.data.orgId, connectionId: job.data.connectionId }),
        );
      }
    }
  });
  // Testing definitions against the data: queries through the gateway, like any other.
  await boss.work<DefinitionChecksJob>(definitionChecksQueue.name, { localConcurrency: 2 }, async ([job]) => {
    if (!job) return;
    const checked = await checkDefinitions({ ...tenantDeps, secrets, edition }, job.data, {
      ...(job.data.all ? { all: true } : {}),
    });
    log("definitions checked", { connectionId: job.data.connectionId, checked });
  });
  // Vectors: an organization's knowledge and tables, embedded where they changed. One batch at a time here.
  await boss.work<EmbedBatchJob>(embedBatchQueue.name, { localConcurrency: 1 }, async ([job]) => {
    if (!job) return;
    const e = await embedder(job.data.orgId);
    if (!e) return;
    try {
      const result = await embedOrganization(tenantDeps, job.data.orgId, e, { signal: job.signal });
      log("embedded", { orgId: job.data.orgId, ...result });
    } catch (error) {
      // Checked, so the tick doesn't queue it again each minute: the job's retries come first, then the next change.
      await tenantDeps.withTenant(job.data.orgId, (tx) => markChecked(tx, job.data.orgId, e.model));
      throw error;
    }
  });
  await boss.work<EmbedBatchJob>(embedBatchDeadLetter.name, async ([job]) => {
    if (!job) return;
    await deadLettered(ops, {
      queue: embedBatchDeadLetter.name,
      orgId: job.data.orgId,
      message: "Its search finds approved knowledge by its words until the next change: check the OpenAI key.",
    });
  });
  await boss.work<DefinitionChecksJob>(definitionChecksDeadLetter.name, async ([job]) => {
    if (!job) return;
    await deadLettered(ops, {
      queue: definitionChecksDeadLetter.name,
      orgId: job.data.orgId,
      message: "They're checked again at the next change to them.",
      detail: { connectionId: job.data.connectionId },
    });
  });
  await boss.work<CatalogSyncJob>(catalogSyncDeadLetter.name, async ([job]) => {
    if (!job) return;
    const settled = await settleSync(tenantDeps, job.data, "failed", {
      message: "Learning this source didn't finish. Try again.",
    });
    await deadLettered(ops, {
      queue: catalogSyncDeadLetter.name,
      orgId: job.data.orgId,
      message: "It was marked failed. Sync the source again.",
      detail: { syncRunId: job.data.syncRunId, settled },
    });
  });
}

// OpenDash in Slack: its socket, when there is one, and its replies, beside the runs they stream.
let slackApp: Awaited<ReturnType<typeof startSlack>> = null;
if (runs("interactive")) {
  const workerId = `${os.hostname()}:${process.pid}`;
  /**
   * A run handed off at a step boundary because this worker is shutting down: what it did is saved, so
   * its job fails here and runs again, picking up where it left off. The attempt isn't counted as a failure.
   */
  function handedOff(result: AttemptResult): asserts result is Exclude<AttemptResult, { status: "handed_off" }> {
    if (result?.status === "handed_off") throw new Error("Handed off: the worker is shutting down; the run goes on.");
  }
  // The web app's origin: where MCP sign-ins come back (the executor names it; calls never send anyone there).
  const mcpOrigin = emailLinkOrigin();
  const agentDeps = {
    // The asker's own transaction, for their personal memory; everything else carries no user.
    withUser: <T>(orgId: string, userId: string, fn: Parameters<typeof withTenant<T>>[1]) =>
      withTenant({ orgId, userId }, fn),
    ...tenantDeps,
    secrets,
    edition,
    model: createModelResolver({ ...tenantDeps, secrets }),
    embedder,
    log,
    // A run that ends with a follow-up still queued starts the next one.
    boss,
    // Connected services (MCP): a call runs in a transaction that carries the asker, since row security
    // shows a person's own connection only to them; it uses the workspace's shared account otherwise.
    ...(mcpOrigin
      ? {
          mcp: {
            secrets,
            edition,
            withTenant: (ctx, fn) => withTenant(ctx, fn),
            redirectUrl: `${mcpOrigin}/api/mcp/callback`,
            clientName: "OpenDash",
          } satisfies mcp.McpDeps,
        }
      : {}),
  } as const;
  // A dashboard's AI summary, written when a person presses Write: a short model call, checked.
  await workDraining(boss, dashboardSummaryQueue, { slots: 2 }, async ([job]) => {
    if (!job) return;
    const done = await writeSummary({ ...agentDeps, boss }, job.data);
    log("dashboard summary", { dashboardId: job.data.dashboardId, done });
  });
  await boss.work<DashboardSummaryJob>(dashboardSummaryDeadLetter.name, async ([job]) => {
    if (!job) return;
    // The summary says it failed (its viewer sees it, with Write to try again), not nothing once the job is gone.
    await dashboards.summaryFailed(tenantDeps, job.data);
    await deadLettered(ops, {
      queue: dashboardSummaryDeadLetter.name,
      orgId: job.data.orgId,
      message: "An App's summary couldn't be written after its retries. Its page says so; pressing Write tries afresh.",
      detail: { dashboardId: job.data.dashboardId },
    });
  });
  // A run is mostly waiting on the model; a few at once per process. The per-org cap (admission) comes with plans.
  await workDraining(boss, agentInteractiveQueue, { slots: 4 }, async ([job]) => {
    if (!job) return;
    // A question's analyst (which builds dashboards too), or Describe it's composer: both are someone waiting.
    const profile = await tenantDeps.withTenant(job.data.orgId, (tx) =>
      runProfileOf(tx, job.data.orgId, job.data.runId),
    );
    const result = await tracked(
      runAttempt(agentDeps, job.data, { workerId, signal: job.signal, drain: drain.signal }),
    );
    handedOff(result);
    log("agent run", { runId: job.data.runId, status: result?.status ?? "not claimed", outcome: result?.outcome });
  });
  // A source's drafting run ended: its next automatic batch, never failing the run's job.
  const draftNext = async (orgId: string, runId: string) => {
    try {
      const next = await nextDraftBatchAfter({ ...tenantDeps, boss, deploymentKeys: deploymentKeys() }, orgId, runId);
      if (next) log("drafting automatically", { runId, ...next });
    } catch (error) {
      log("automatic drafting failed", { runId, error: (error as Error).name });
    }
  };
  // Background runs, apart from the questions' pool: two at a time per process. A routine's scheduled question sends
  // its answer when it ends; an investigation settles, releasing the routine
  // runs that waited for it; the verdict never changes the insight itself (32466eb).
  await boss.work<AgentRunJob>(agentBackgroundQueue.name, { localConcurrency: 2 }, async ([job]) => {
    if (!job) return;
    const { orgId, runId } = job.data;
    const profile = await tenantDeps.withTenant(orgId, (tx) => runProfileOf(tx, orgId, runId));
    if (profile === "analyst") {
      const result = await tracked(
        runAttempt(agentDeps, job.data, { workerId, signal: job.signal, drain: drain.signal }),
      );
      handedOff(result);
      const routine = await finishAgentRun({ ...tenantDeps, boss }, orgId, runId);
      log("routine's agent run", { runId, profile, status: result?.status ?? "not claimed", routine });
      return;
    }
    // A learning: the Curator proposes a term from corrections; settled, it's checked and tested next.
    if (profile === "curator") {
      const result = await tracked(
        runAttempt(agentDeps, job.data, { workerId, signal: job.signal, drain: drain.signal }),
      );
      handedOff(result);
      const learning = await settleLearning({ ...tenantDeps, boss }, orgId, runId);
      log("curator", { runId, status: result?.status ?? "not claimed", outcome: result?.outcome, learning });
      return;
    }
    // Make this a metric: the Modeler drafts, then its proposal opens for review or says why it couldn't.
    if (profile === "modeler") {
      const result = await tracked(
        runAttempt(agentDeps, job.data, { workerId, signal: job.signal, drain: drain.signal }),
      );
      handedOff(result);
      const proposal = await settleProposal(tenantDeps, orgId, runId);
      log("modeler", { runId, status: result?.status ?? "not claimed", outcome: result?.outcome, proposal });
      await draftNext(orgId, runId);
      return;
    }
    await tenantDeps.withTenant(job.data.orgId, (tx) => investigationStarted(tx, job.data.orgId, job.data.runId));
    const result = await tracked(
      runAttempt(agentDeps, job.data, { workerId, signal: job.signal, drain: drain.signal }),
    );
    handedOff(result);
    const status = await settleInvestigation({ ...tenantDeps, boss }, job.data.orgId, job.data.runId);
    log("investigation", {
      runId: job.data.runId,
      status: result?.status ?? "not claimed",
      outcome: result?.outcome,
      investigation: status,
    });
  });
  await boss.work<AgentRunJob>(agentBackgroundDeadLetter.name, async ([job]) => {
    if (!job) return;
    const { orgId, runId } = job.data;
    const profile = await tenantDeps.withTenant(orgId, (tx) => runProfileOf(tx, orgId, runId));
    if (profile === "curator") {
      const failed = await failRunFromQueue({ ...tenantDeps, boss }, job.data, "The Curator stopped unexpectedly.");
      await settleLearning({ ...tenantDeps, boss }, orgId, runId);
      await deadLettered(ops, {
        queue: agentBackgroundDeadLetter.name,
        orgId,
        message: "Its retries ran out, so the learning was marked failed. The next correction about it starts again.",
        detail: { runId, failed },
      });
      return;
    }
    if (profile === "modeler") {
      const failed = await failRunFromQueue({ ...tenantDeps, boss }, job.data, "The Modeler stopped unexpectedly.");
      await settleProposal(tenantDeps, orgId, runId);
      await draftNext(orgId, runId);
      await deadLettered(ops, {
        queue: agentBackgroundDeadLetter.name,
        orgId,
        message: "Its retries ran out, so the draft was marked failed. Make this a metric starts it again.",
        detail: { runId, failed },
      });
      return;
    }
    if (profile === "analyst") {
      const failed = await failRunFromQueue({ ...tenantDeps, boss }, job.data, "The analyst stopped unexpectedly.");
      // The routine's question fails, and its run says so.
      await finishAgentRun({ ...tenantDeps, boss }, orgId, runId);
      await deadLettered(ops, {
        queue: agentBackgroundDeadLetter.name,
        orgId,
        message: "Its retries ran out, so the routine's question was marked failed.",
        detail: { runId, failed },
      });
      return;
    }
    const failed = await failRunFromQueue({ ...tenantDeps, boss }, job.data, "The Investigator stopped unexpectedly.");
    await settleInvestigation({ ...tenantDeps, boss }, job.data.orgId, job.data.runId);
    await deadLettered(ops, {
      queue: agentBackgroundDeadLetter.name,
      orgId: job.data.orgId,
      message: "Its retries ran out, so the investigation was marked failed. Investigate starts it again.",
      detail: { runId: job.data.runId, failed },
    });
  });
  await boss.work<AgentRunJob>(agentInteractiveDeadLetter.name, async ([job]) => {
    if (!job) return;
    const profile = await tenantDeps.withTenant(job.data.orgId, (tx) =>
      runProfileOf(tx, job.data.orgId, job.data.runId),
    );
    const failed = await failRunFromQueue(
      { ...tenantDeps, boss },
      job.data,
      profile === "composer"
        ? "It stopped unexpectedly. Try again, or pick each part below."
        : "The analyst stopped unexpectedly. Ask again.",
    );
    await deadLettered(ops, {
      queue: agentInteractiveDeadLetter.name,
      orgId: job.data.orgId,
      message: "Its retries ran out, so the question was marked failed. Asking again starts afresh.",
      detail: { runId: job.data.runId, failed },
    });
  });

  // Learning from corrections: the Curator started on corrections every minute, and each learning checked,
  // tested and decided.
  await startLearning({
    ...tenantDeps,
    boss,
    withSystem,
    secrets,
    edition,
    deploymentKeys,
    agentDeps,
    workerId,
    drain: drain.signal,
    log,
    // Read when a learning is decided: Slack starts just below.
    tell: (orgId, proposalId) => slackApp?.tellLearning(orgId, proposalId) ?? null,
  });

  // The context graph: each organization's rebuilt every minute its knowledge changed.
  await startGraph({ boss, withSystem, withTenant: tenantDeps.withTenant, log });

  slackApp = await startSlack({ boss, secrets, log, drain: drain.signal }).catch((error: unknown) => {
    // Slack being unreachable or misconfigured never stops the worker; questions from the web go on.
    log("slack failed to start", { error: loggableError(error) });
    return null;
  });

  // The organization's evals (evals/run.ts): a case is the real analyst asked headlessly, as of the case's time, in a
  // thread nobody owns (so it's in nobody's Ask history). One at a time per process: evals never crowd out people.
  // A case asks on its eval run's model, provider and level (the default when it started): all of them passed on, so
  // none falls back to OpenDash's own provider. It stops with its job (expired, or the worker shutting down). Handed off,
  // its run ends (nothing would run it again: it has no job of its own) and the case's job runs again from the start.
  const askFor =
    (job: { signal: AbortSignal }): EvalAsk =>
    async ({ question, asOf, ...choice }) => {
      const { orgId } = choice;
      const submitted = await submitQuestion(
        { ...tenantDeps, boss: null },
        { ...choice, userId: null, text: question, channel: "eval" },
      );
      // Handed off at a step, or stopped mid-step when the shutdown's grace (or the job) ran out: either way its run
      // ends here and the case is asked again, never graded as an error.
      const stopped = async () => {
        await failRunFromQueue(
          { ...tenantDeps, boss },
          { orgId, runId: submitted.runId },
          "The worker shut down; the case is asked again.",
        );
        return new EvalHandedOff("Handed off: the worker is shutting down; the case is asked again.");
      };
      let attempt: AttemptResult;
      try {
        attempt = await runAttempt(
          { ...agentDeps, now: () => asOf },
          { orgId, runId: submitted.runId },
          { workerId, signal: job.signal, drain: drain.signal },
        );
      } catch (error) {
        if (job.signal.aborted || drain.signal.aborted) throw await stopped();
        throw error;
      }
      if (attempt?.status === "handed_off") throw await stopped();
      const run = await getRun(tenantDeps, { orgId, userId: null }, submitted.runId);
      return {
        runId: submitted.runId,
        outcome: (run?.outcome ?? null) as AnswerOutcome | null,
        usage: (run?.usage ?? {}) as { modelCalls?: number; costUsd?: number },
      };
    };
  const evalDeps = { ...tenantDeps, secrets, edition, boss } as const;
  await boss.work<EvalRunJob>(evalRunQueue.name, async ([job]) => {
    if (!job) return;
    log("eval run", { evalRunId: job.data.evalRunId, ...(await beginEvalRun(evalDeps, job.data)) });
  });
  await boss.work<EvalRunJob>(evalRunDeadLetter.name, async ([job]) => {
    if (!job) return;
    await failEvalRun(tenantDeps, job.data);
    await deadLettered(ops, {
      queue: evalRunDeadLetter.name,
      orgId: job.data.orgId,
      message: "It was marked failed. Run the evals again.",
      detail: { evalRunId: job.data.evalRunId },
    });
  });
  await boss.work<EvalCaseJob>(evalCaseQueue.name, { localConcurrency: 1 }, async ([job]) => {
    if (!job) return;
    await executeEvalCase(evalDeps, job.data, askFor(job));
  });
  await boss.work<EvalCaseJob>(evalCaseDeadLetter.name, async ([job]) => {
    if (!job) return;
    await failEvalCase(tenantDeps, job.data);
    await deadLettered(ops, {
      queue: evalCaseDeadLetter.name,
      orgId: job.data.orgId,
      message: "It counts as failed in its run.",
      detail: { evalRunId: job.data.evalRunId, caseId: job.data.caseId },
    });
  });
  await boss.work(evalScheduleQueue.name, async () => {
    log("nightly evals", await dispatchNightlyEvals({ ...tenantDeps, withSystem, boss }));
  });
  await boss.work(evalScheduleDeadLetter.name, async () => {
    await deadLettered(ops, { queue: evalScheduleDeadLetter.name, message: "Nightly evals failed to start." });
  });
  await boss.schedule(evalScheduleQueue.name, "0 3 * * *", {}, { tz: "UTC" });

  // A workspace's AI provider: its credentials opened here only, its list read, one tiny call; and once a
  // day, each working provider's list read again.
  await workDraining(boss, aiProviderTestQueue, { slots: 2 }, async ([job]) => {
    if (!job) return;
    const result = await testProvider({ ...tenantDeps, secrets }, job.data, checkProvider);
    log("provider tested", { kind: job.data.kind, refresh: job.data.refresh === true, ok: result?.ok ?? null });
  });
  await boss.work<AiProviderTestJob>(aiProviderTestDeadLetter.name, async ([job]) => {
    if (!job) return;
    await failProviderTest(tenantDeps, job.data);
    await deadLettered(ops, {
      queue: aiProviderTestDeadLetter.name,
      orgId: job.data.orgId,
      message: "It was marked failed. Test the provider again.",
      detail: { kind: job.data.kind },
    });
  });
  await boss.work(aiProviderRefreshQueue.name, async () => {
    log(
      "provider lists refreshed",
      await dispatchProviderRefresh({ withSystem, withTenant: tenantDeps.withTenant, boss }),
    );
  });
  await boss.work(aiProviderRefreshDeadLetter.name, async () => {
    await deadLettered(ops, {
      queue: aiProviderRefreshDeadLetter.name,
      message: "Providers' lists weren't refreshed.",
    });
  });
  await boss.schedule(aiProviderRefreshQueue.name, "41 4 * * *", {}, { tz: "UTC" });
}

// Partition upkeep on every worker: hourly, and once now so a fresh database never waits an hour for tomorrow's day.
// Then the prompt layers no run refers to any more, which can never fail the upkeep: it waits for the next hour.
await boss.work(maintenanceQueue.name, async () => {
  const done = await maintainPartitions(
    withSystem,
    edition,
    auditRetentionDays(enterprise(), process.env.OPENDASH_AUDIT_RETENTION_DAYS),
  );
  log("partitions", done);
  await partitionsChecked(ops, done.missing);
  await dropUnusedPrompts(withSystem).then(
    (count) => count && log("prompt layers dropped", { count }),
    (error: unknown) =>
      log("couldn't drop unused prompt layers", { error: error instanceof Error ? error.name : "error" }),
  );
  // Slack links used, or expired a day ago: each keeps a Slack email it no longer needs. Add to Slack
  // installs never confirmed go too, with the tokens they held.
  await purgeSlackLinks(withSystem).then(
    (count) => count && log("slack links purged", { count }),
    (error: unknown) => log("couldn't purge slack links", { error: error instanceof Error ? error.name : "error" }),
  );
  await purgeSlackInstalls(withSystem).then(
    (count) => count && log("slack installs purged", { count }),
    (error: unknown) => log("couldn't purge slack installs", { error: error instanceof Error ? error.name : "error" }),
  );
  // Slack's questions from over a week ago: what Slack sent went once each was handled.
  await purgeSlackInbound(withSystem).then(
    (count) => count && log("slack questions purged", { count }),
    (error: unknown) => log("couldn't purge slack questions", { error: error instanceof Error ? error.name : "error" }),
  );
});
await boss.work(maintenanceDeadLetter.name, async () => {
  await deadLettered(ops, {
    queue: maintenanceDeadLetter.name,
    message: "Partition upkeep failed: future writes may fail. Check the worker's logs.",
  });
});
await boss.schedule(maintenanceQueue.name, "17 * * * *");
await boss.send(maintenanceQueue.name, {}, { singletonKey: "startup" });

// The dispatcher: once a minute for the deployment, whichever worker gets it. It alarms on stuck
// runs and lost jobs and records that it ran, for the health check.
await boss.work(systemTickQueue.name, async () => {
  const result = await systemTick({
    ...ops,
    boss,
    tasks: [
      (now) => warnSpend(ops, now),
      // Scheduled routines due: one run each for their latest due time, and their next time set.
      (now) => queueDueRoutines({ ...ops, withTenant: tenantDeps.withTenant, boss }, now),
      // Metric checks due: each queued once, read at the check hour where the workspace is.
      (now) => queueDueChecks({ ...ops, withTenant: tenantDeps.withTenant, boss }, now),
      // Routine runs that waited (a roundup's 07:00, an investigation overdue): they go now.
      (now) => releaseDueRuns({ ...ops, withTenant: tenantDeps.withTenant, boss }, now),
      // Runs that waited longer than pg-boss keeps a job: failed, so the spend room they held goes back.
      (now) => failStaleQueuedRuns({ ...ops, withTenant: tenantDeps.withTenant, boss }, now),
      // Workspaces that were deleted: their queued jobs, and the history no foreign key reaches, a batch at a time.
      async () => {
        const purged = await purgeDeletedOrgs({ ...ops, boss });
        if (purged.purged || purged.rows || purged.jobs) log("deleted organizations purged", purged);
      },
      // Done tasks whose outcome is due.
      (now) => queueDueOutcomeChecks({ ...ops, withTenant: tenantDeps.withTenant, boss }, now),
      // Audit rows written since the last minute, sealed into each organization's chain (ee/).
      async () => {
        const sealed = await enterprise().audit?.seal(withSystem);
        if (sealed?.rows) log("audit sealed", sealed);
      },
      // Knowledge and tables changed since they were embedded (vectors).
      (now) =>
        queueStaleEmbeddings(
          {
            ...ops,
            withTenant: tenantDeps.withTenant,
            boss,
            deploymentKey: Boolean(process.env.OPENAI_API_KEY?.trim()),
          },
          now,
        ),
    ],
  });
  if (result.stuck || result.lostJobs) log("tick", { ...result });
});
await boss.work(systemTickDeadLetter.name, async () => {
  await deadLettered(ops, { queue: systemTickDeadLetter.name, message: "The dispatcher's tick failed." });
});
await boss.schedule(systemTickQueue.name, "* * * * *");

// Usage by day (usage_daily), hourly: the last 2 days recomputed from the events.
await boss.work(usageRollupQueue.name, async () => {
  log("usage rolled up", await rollupUsage(ops));
});
await boss.work(usageRollupDeadLetter.name, async () => {
  await deadLettered(ops, { queue: usageRollupDeadLetter.name, message: "Rolling up usage by day failed." });
});
await boss.schedule(usageRollupQueue.name, "23 * * * *");

log("worker ready", { pools: [...pools], edition, license: enterprise().status().state, node: process.version });

// Apps built before select to edit are built again, once, so their pieces can be selected (not awaited: it never holds
// the worker up, and an App that won't build again keeps its old bundle).
if (runs("sync"))
  void rebuildUnmarkedBundles({ withSystem, log }).catch((error) =>
    log("bundle rebuild stopped", { error: loggableError(error) }),
  );

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log("worker stopping", { signal });
  // Agent runs and Slack replies hand off at their next boundary, within pg-boss's grace, instead of being cut off.
  // Slack's events stop first; the bot stops last, once the replies posting through it are done.
  drain.abort();
  await slackApp?.stopListening();
  await boss.stop({ graceful: true, timeout: BUDGETS.queue.shutdownGraceMs });
  await slackApp?.stop();
  // An attempt the grace cut off mid-step is still unwinding (its tools stop through their signal, then it records
  // that a shutdown ended it): it finishes before the databases close, within a bound.
  await Promise.race([
    Promise.allSettled([...attempts]),
    new Promise((resolve) => setTimeout(resolve, BUDGETS.queue.unwindMs)),
  ]);
  await telemetry?.shutdown().catch(() => {});
  await closeDatabases();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

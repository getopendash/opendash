/**
 * The time-budget table. Every timeout
 * comes from here, and test/budgets.test.ts checks the inequalities between them, so no two timers can race.
 */
export const BUDGETS = {
  /** pg-boss liveness, per worker instance (detection ≈ heartbeat + max(supervise, monitor)). */
  queue: {
    superviseIntervalSeconds: 5,
    monitorIntervalSeconds: 5,
    shutdownGraceMs: 30_000,
    /** After the grace: how long a shutdown waits for attempts it cut off mid-step to unwind before closing. */
    unwindMs: 10_000,
  },
  /** Testing a customer database connection: reach, sign in, two catalog queries. */
  connectionTest: {
    connectMs: 10_000,
    statementMs: 10_000,
    heartbeatSeconds: 10,
    jobExpireSeconds: 60,
    /** How long a passing test can be used to create a connection. */
    validForMs: 30 * 60_000,
    /** The UI says the worker isn't picking it up after this long in the queue. */
    queuedWarningMs: 15_000,
  },
  /** The query gateway: every query OpenDash runs on a source. */
  gateway: {
    connectMs: 10_000,
    /** Server-side, per agent query (warehouse statement 60 s). Below the sql_query tool timeout. */
    statementMs: 60_000,
    explainMs: 10_000,
    /** Rows and bytes read from the source per query; anything past them is reported as truncated. */
    maxRows: 1_000,
    maxBytes: 2_000_000,
    /** What query_run keeps for the trace and the answer gate. */
    previewRows: 100,
    previewBytes: 32_000,
    /** Queries running at once per source, per worker process. */
    perConnection: 4,
  },
  /**
   * An agent run. Its time is working time, summed over its attempts, so a retry
   * never starts a fresh clock; a gap while a job waits for its retry or for a deploy doesn't count.
   */
  agent: {
    /** Each kind's working time, and when it wraps up (only its ending tools left). */
    kinds: {
      /** A person waits: one question, answered or asked back. */
      interactive: { wallMs: 5 * 60_000, wrapUpAtMs: 4 * 60_000 },
      /** Nobody waits: an investigation, a routine's written summary or question. */
      background: { wallMs: 10 * 60_000, wrapUpAtMs: 8 * 60_000 },
      /** A drafting batch, ten tables tested on the data. */
      drafting: { wallMs: 15 * 60_000, wrapUpAtMs: 12 * 60_000 },
    },
    maxSteps: 24,
    /** The steps left after the nudge, which may only end the run. */
    nudgeSteps: 3,
    /** The Analyst's own budget: about twice the biggest of 94 recorded runs (18 calls, 16 queries, $0.37). */
    analyst: { maxToolCalls: 40, maxQueries: 25, maxCostUsd: 1.5 },
    /**
     * The most a run of each agent may spend: what an unfinished run holds against the spend limits until it ends
     * (usage/limits.ts). The modeler's is a full drafting batch (sourceDraftBudget at DRAFT_TABLES_MAX). Each agent's
     * own budget must stay within its line here (packages/agent/test/run-caps.test.ts).
     */
    runCostCapsUsd: {
      analyst: 1.5,
      investigator: 2,
      modeler: 5.5,
      curator: 0.3,
      composer: 0.25,
    },
    /** Failed sql_query / sql_check calls before the run must answer with what it has (repair ≤3 per query). */
    maxFailedQueries: 6,
    /** Answers the gate may send back before the last one ships with Unverified marks. */
    answerRepairs: 2,
    /**
     * A model call's own stream: its first byte, and the longest gap between bytes. Measured on the call's response,
     * never on a tool's time (the SDK's stepMs and chunkMs run on while a step's tools work).
     */
    modelFirstByteMs: 60_000,
    modelIdleMs: 90_000,
    /** Tools by how long their work takes: a query (above the gateway's statement timeout plus connecting), a tool that tests on the data (definition and filter checks), the rest. */
    tools: { queryMs: 75_000, slowMs: 4 * 60_000, quickMs: 15_000, childMs: 12 * 60_000 },
    /** Rows of a result the model sees; references can cite only these. */
    rowsToModel: 50,
    /**
     * What a model call may send (agent harness/window.ts), in tokens: the model's window less room to answer, and
     * under a price line (Haiku 5.5 costs 5× past 100,000 input tokens). Past it the conversation folds down by the
     * headroom, about twice a recorded run's growth (11.5k at the 90th percentile, 42k at most, Haiku analyst), so a
     * fold holds for the rest of the run. The latest results of the run's own turn stay whole.
     */
    window: { reserveTokens: 16_000, priceMarginTokens: 5_000, headroomTokens: 24_000, keepRecentTokens: 20_000 },
    heartbeatSeconds: 10,
    /** agent.interactive: its longest working time (a dashboard's build, 9 min), then a slow tool's and a margin. */
    jobExpireSeconds: 14 * 60,
    /** agent.background: a drafting batch's working time, then a slow tool's and a margin. */
    backgroundJobExpireSeconds: 20 * 60,
    /** pg-boss's retries: room for shutdown hand-offs, which aren't failures; the run fails at attemptFailures first. */
    retryLimit: 6,
    /** Attempts that ended in a failure (a crash, the model, an expired job; never a hand-off) before the run fails. */
    attemptFailures: 3,
    retryDelaySeconds: 2,
    /**
     * The longest a run waits queued: pg-boss keeps a waiting job this long (its default retention). Past it the run
     * fails (failStaleQueuedRuns), so it's never sent again after the room it held was given to other work.
     */
    queuedMaxSeconds: 14 * 24 * 3600,
  },
  /**
   * Routines. A finding told after its investigation waits at most this long for it: a background run's
   * working time and a retry or two; overdue, it's told without the verdict.
   */
  routines: { investigateWaitMs: 30 * 60_000 },
  /**
   * Slack's Web API: from OpenDash's own code (channels, a routine's post, looking for one an earlier attempt
   * may have made) and through the chat client (replies, App Home, notices). Each call; a slow one is retried by its
   * job, never waited on. The chat client waits out a rate limit and tries again at most `rateLimitRetries` times,
   * nothing else. The worker waits `socketConnectWaitMs` for its first Socket Mode connection, then goes on (it keeps
   * connecting).
   */
  slack: { apiMs: 10_000, rateLimitRetries: 2, socketConnectWaitMs: 30_000 },
  /**
   * One email to the provider (Resend or SMTP). One cut off isn't sent again, since it may have gone; an
   * SMTP server also gets these to connect and to answer, so a silent one ends the send itself.
   */
  email: { sendMs: 15_000, smtpConnectMs: 5_000, smtpSocketMs: 10_000 },
  /**
   * Product analytics (ops/analytics.ts), only where POSTHOG_KEY is set. One event or error sent from the server is
   * waited on this long, then dropped: a lost event costs nothing, a slow sign-up does. The web app's /ingest relay
   * gives the browser's batches `relayMs` and refuses one past `relayBytes`.
   */
  analytics: { sendMs: 2_000, relayMs: 10_000, relayBytes: 1_000_000 },
  /** effect.send: one outbox row. Its longest send (a channel post that looks for itself first) fits inside. */
  delivery: { jobExpireSeconds: 120 },
  /** Partition upkeep (maint.partitions): hourly and at worker start. */
  maintenance: { jobExpireSeconds: 55 },
  /**
   * The app database: a transaction waits this long for a lock it serializes on (`lockFor`), well inside the app
   * role's statement timeout (15 s, set where the database is: packages/db/src/bootstrap.ts).
   */
  db: { lockWaitMs: 5_000 },
  /** The minute's tick (system.tick): done, or given up on, before the next one starts. */
  tick: { jobExpireSeconds: 50 },
  /**
   * The small jobs that look for what's due each minute or so (slack.inbound.check, learning.dispatch,
   * graph.dispatch), and the context graph's projection of one organization (graph.project).
   */
  dispatch: { jobExpireSeconds: 120, graphProjectExpireSeconds: 5 * 60 },
  /**
   * Vectors: `context_search` waits this long for its query's vector, then searches by words alone; an
   * organization's batch (embed.batch) has the job's time.
   */
  embed: { queryMs: 8_000, jobExpireSeconds: 15 * 60 },
  /**
   * A provider's test (ai_provider.test): reading its model list, then one tiny question to its cheapest
   * model; Vertex, with no list, one tiny question to each allowlisted model, a few at a time.
   */
  aiProviderTest: { listMs: 15_000, callMs: 30_000, probeConcurrency: 3, jobExpireSeconds: 180 },
  /**
   * Single sign-on (ee/): resolving an identity provider's host before it's trusted; asking a domain's own
   * nameservers for its TXT record (each query, then the whole check: NS, their addresses and the TXT, under one
   * deadline); fetching a SAML provider's metadata once, at registration.
   */
  sso: { lookupMs: 3_000, dnsQueryMs: 3_000, dnsCheckMs: 8_000, metadataMs: 10_000, metadataBytes: 100_000 },
  /**
   * Dashboards. An answer to a dashboard's query is shared for `resultSeconds` (every viewer asking the same
   * thing gets the same one) and asked again after; the page waits `waitMs` for one before it says the warehouse is
   * slow. A frame's signed link lasts `frameSeconds`.
   */
  dashboards: {
    resultSeconds: 300,
    waitMs: 90_000,
    frameSeconds: 12 * 3600,
  },
  /**
   * MCP servers. Every request to one, or to its authorization server (discovery, registration, token,
   * refresh), goes through the guarded fetch: its host resolved within `lookupMs`, the whole request within
   * `requestMs`, at most `redirects` hops each vetted again, a body of at most `responseBytes`. A tool call (connect,
   * the call) is over by `callMs`; listing tools by `listMs`. A sign-in in flight lasts `flowMs`.
   */
  mcp: {
    lookupMs: 3_000,
    requestMs: 15_000,
    redirects: 3,
    responseBytes: 2_000_000,
    /** Within the analyst's 75 s for a query-type tool (mcp_call). */
    callMs: 70_000,
    listMs: 20_000,
    /** Finding how a server signs people in, every request of it together. */
    detectMs: 30_000,
    flowMs: 10 * 60_000,
    /** One call refreshes a connection's tokens at a time; the others wait at most this long for its result. */
    refreshLeaseMs: 15_000,
    maxTools: 200,
  },
  /** Learning a source: reading the schema, profiling every table, indexing values. */
  catalogSync: {
    connectMs: 10_000,
    /** Server-side, per statement on the customer's database. */
    statementMs: 15_000,
    heartbeatSeconds: 30,
    jobExpireSeconds: 30 * 60,
    /** Each job stops starting new work after this, finishes what it's doing, and reports what it covered. */
    wallMs: 25 * 60_000,
    maxRelations: 2_000,
    sampleRows: 2_000,
    /**
     * A table's sample holds at most this many cells (rows × columns, each cut to 256 characters on the server): a
     * wide table is sampled in fewer rows, so one table can't fill the worker's memory (at most ~50 MB of text).
     */
    maxSampleCells: 100_000,
    /** A table's, column's or schema's comment is kept to this many characters. */
    maxCommentChars: 2_000,
    categoryMaxNdv: 50,
    /** The value index: columns with at most this many distinct values, top N values each. */
  },
} as const;

/** Worst case for one connection test: TCP connect, sign-in, and the privilege and catalog queries. */
export const connectionTestWorstCaseMs = () => {
  const b = BUDGETS.connectionTest;
  return 2 * b.connectMs + 2 * b.statementMs;
};

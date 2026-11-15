/**
 * The API's contracts: plain Zod, one per procedure. They serve the web UI (typed calls), and later the
 * public REST API, the CLI and MCP tools, generated from the same definitions. Ask's come first: the sources one can
 * ask about, conversations, runs and the query behind a number. Run progress is polled here (runs.events); SSE replaces
 * it on its own endpoint. REST paths for the public API come with @orpc/openapi's route metadata.
 */

import {
  type AiSettingsView,
  type Attachable,
  type CallDetail,
  type dashboards,
  type EvalOverview,
  type EvalResultView,
  type EvalRunSummary,
  LEVELS,
  type LearningCard,
  type LearningChoice,
  type ModelChoice,
  type MyFeedback,
  type mcp,
  type OfferedModels,
  PROVIDER_KINDS,
  type ProviderTestView,
  type QueryCard,
  REASONS,
  type Readiness,
  type ReadReference,
  type RecentRun,
  type RecordsAnswer,
  type RunOutcome,
  type RunView,
  type SpendView,
  THREAD_STATES,
  type ThreadSummary,
  type ThreadTurn,
  type TraceView,
} from "@opendash/core";
import { oc } from "@orpc/contract";
import { z } from "zod";

const Id = z.uuid();
const LEVEL_IDS = LEVELS.map((l) => l.id) as ["low", "medium", "high", "xhigh", "max"];

/** Every procedure needs a signed-in member of an organization (a session; API keys come with the public API). */
const authed = oc.errors({
  UNAUTHORIZED: { message: "Sign in to continue." },
  FORBIDDEN: { message: "You don't have access to this organization." },
});

const NOT_FOUND = { message: "That doesn't exist, or you can't see it." };
const INVALID = { message: "That change can't be made." };

export const AskableSource = z.object({
  id: Id,
  name: z.string(),
  dialect: z.string(),
  sample: z.boolean(),
  /** Its queries can't connect (a wrong password, a host gone): why, in words to act on. */
  failing: z.string().nullable().optional(),
});
export type AskableSource = z.infer<typeof AskableSource>;

/** Sources that can be asked about. */
const sourcesAskable = authed.output(z.array(AskableSource));

/** Questions to start with, from what was learned about a source. */
const sourcesSuggestions = authed
  .errors({ NOT_FOUND })
  .input(z.object({ connectionId: Id }))
  .output(z.array(z.string()));

/** How ready a source is to answer questions, out of 100, with what to do next (owners and admins). */
const sourcesReadiness = authed
  .errors({ NOT_FOUND })
  .input(z.object({ connectionId: Id }))
  .output(z.custom<Readiness>());

/** A conversation as the API lists it: with its author's name when someone else started it (a shared one). */
export type ThreadListing = ThreadSummary & { author: string | null };

/**
 * Conversations, newest activity first. Narrowed by whose (shared: others' conversations shared with the
 * caller; starred: the caller's stars), a project, how each stands, and words that must each appear in the title, a
 * question or an answer.
 */
const threadsList = authed
  .input(
    z.object({
      scope: z.enum(["all", "mine", "shared", "starred"]).default("all"),
      projectId: Id.optional(),
      state: z.enum(THREAD_STATES).optional(),
      q: z.string().max(200).optional(),
      /** Conversations where a question attached this: a definition's "Earlier about this". */
      attached: z
        .object({ kind: z.enum(["metric", "dataset", "guide", "verified_query", "skill", "dashboard"]), id: Id })
        .optional(),
      limit: z.int().min(1).max(200).default(50),
      offset: z.int().min(0).max(100_000).default(0),
    }),
  )
  .output(z.array(z.custom<ThreadListing>()));

/** A conversation and its turns. */
const threadsGet = authed
  .errors({ NOT_FOUND })
  .input(z.object({ threadId: Id }))
  .output(z.object({ thread: z.custom<ThreadListing>(), turns: z.array(z.custom<ThreadTurn>()) }));

/** Shares a conversation with the organization for reading, or makes it private again (its author only). */
const threadsShare = authed
  .errors({ NOT_FOUND })
  .input(z.object({ threadId: Id, visibility: z.enum(["private", "project", "org"]) }))
  .output(z.object({ visibility: z.enum(["private", "project", "org"]) }));

/** Stars or unstars a conversation the caller can read, for their Starred list (theirs alone; a person, not a key). */
const threadsStar = authed
  .errors({ NOT_FOUND })
  .input(z.object({ threadId: Id, starred: z.boolean() }))
  .output(z.object({ starred: z.boolean() }));

/** Ask a question, or follow up in a conversation. */
/**
 * Something attached to a question, as its context. A skill may name a version: owners and admins try a draft (a
 * skill's Try now).
 */
const Attachment = z.object({
  kind: z.enum(["metric", "dataset", "guide", "verified_query", "skill", "dashboard", "file", "image", "app_element"]),
  id: Id,
  version: z.int().min(1).optional(),
  /** A reference the person attached, as OpenDash's reader read it: a file's text, an image's bytes. */
  name: z.string().max(120).optional(),
  /** A file's text; a selected piece of an App's own short text (at most 200 characters, checked on the server). */
  text: z.string().max(70_000).optional(),
  mediaType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]).optional(),
  data: z.string().max(4_200_000).optional(),
  /**
   * A piece of an App its owner selected (select to edit): the App, the revision drawn, and where the piece was
   * written. A hint from the App's frame: the server checks each part against the App's stored files.
   */
  dashboardId: Id.optional(),
  revision: z.string().max(128).optional(),
  file: z.string().max(240).optional(),
  line: z.int().min(1).max(1_000_000).optional(),
  column: z.int().min(0).max(1_000_000).optional(),
  tag: z.string().max(32).optional(),
});

/** What the composer's picker offers on a source: metrics, datasets, guides, verified queries, skills, dashboards. */
export type { Attachable };
export type AttachmentInput = z.infer<typeof Attachment>;

const askAttachable = authed
  .input(z.object({ connectionId: Id, q: z.string().max(80).optional() }))
  .output(z.custom<Attachable[]>());

/** A file or image the person adds to a question, read by OpenDash's reader (nothing in it runs). */
const askReadReference = authed
  .errors({ TOO_MANY_READS: { message: "That's a lot of files at once: wait a minute and add the rest." } })
  .input(z.object({ name: z.string().max(200), data: z.string().max(11_200_000) }))
  .output(z.custom<ReadReference & { id: string }>());

const askSubmit = authed
  .errors({
    NOT_FOUND,
    INVALID: { message: "That can't be asked here." },
    SPEND_LIMIT: { message: "A spend limit for AI was reached." },
    RUN_ACTIVE: { message: "The analyst is still working on this conversation. Wait for it, or stop it." },
  })
  .input(
    z
      .object({
        text: z.string().trim().min(1).max(4000),
        /** Where the question starts: a new conversation needs one; a follow-up can switch to another. */
        connectionId: Id.optional(),
        threadId: Id.optional(),
        /** Makes a retried submit the same question rather than asking twice. */
        clientMsgId: z.string().max(64).optional(),
        /** The model to ask with, from those the organization offers; the default when absent. */
        model: z.string().max(80).optional(),
        /** The provider it runs on; where the default's runs, or the first that offers it, when absent. */
        provider: z.enum(PROVIDER_KINDS).optional(),
        /** How long it thinks; Auto when absent, or a level the model doesn't take. */
        reasoning: z.enum(LEVEL_IDS).optional(),
        /** What the asker attaches: up to five things they can read on the conversation's source. */
        attachments: z.array(Attachment).max(5).optional(),
        /** Start the conversation in this project, shared with its people (its editors and managers only). */
        projectId: Id.optional(),
      })
      .refine((v) => v.connectionId || v.threadId, { message: "Pick a source to ask about." }),
  )
  /** queued: sent while the conversation's answer was worked on, so it joins that run. */
  .output(z.object({ threadId: Id, runId: Id, queued: z.boolean() }));

/** Its author takes back a follow-up that hasn't been read yet. */
const askTakeBack = authed.input(z.object({ messageId: Id })).output(z.object({ takenBack: z.boolean() }));

const RunEvent = z.object({
  seq: z.int(),
  attempt: z.int(),
  type: z.string(),
  data: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});
export type RunEvent = z.infer<typeof RunEvent>;

/** A run's events after a sequence number (polling). */
const runsEvents = authed
  .errors({ NOT_FOUND })
  .input(z.object({ runId: Id, afterSeq: z.int().min(0).default(0) }))
  .output(
    z.object({
      events: z.array(RunEvent),
      run: z.object({
        status: z.string(),
        attempt: z.int(),
        outcome: z.custom<RunOutcome | null>(),
        error: z.string().nullable(),
      }),
    }),
  );

/** Stop a run. */
const runsStop = authed.input(z.object({ runId: Id })).output(z.object({ stopped: z.boolean() }));

/**
 * A run's trace: its model and tool calls with their times, tokens and costs, its attempts, its drafters
 * nested, and its totals; as its conversation is seen, and background work for owners and admins.
 */
const runsTrace = authed
  .errors({ NOT_FOUND })
  .input(z.object({ runId: Id }))
  .output(z.custom<TraceView>());

/**
 * One call of a run in full (its input, what came back; a query's SQL and first rows), for the chat's step that opens
 * to it: the person who asked only, null for anyone else. Named `step`: `call` is taken, every
 * procedure's query helper has a .call().
 */
const runsStep = authed
  .input(z.object({ runId: Id, callId: z.string().min(1).max(200) }))
  .output(z.custom<CallDetail | null>());

/** A run as Activity lists it, with who asked by name. */
export type RecentRunView = RecentRun & { askedByName: string | null };

/** Activity: the workspace's recent runs, for its owners and admins. */
const runsRecent = authed
  .input(
    z.object({
      limit: z.int().min(1).max(200).default(50),
      before: z.iso.datetime().optional(),
      background: z.boolean().optional(),
    }),
  )
  .output(z.array(z.custom<RecentRunView>()));

/** The query behind a number. */
const queriesGet = authed
  .errors({ NOT_FOUND })
  .input(z.object({ queryRunId: Id }))
  .output(z.custom<QueryCard>());

/**
 * The records behind a number (a dashboard figure's or an answer's metric query): a page of the rows it counts, with
 * their total, or `queued` while the worker reads them (ask again). The number is named by its query run and where in
 * it was clicked: a row of its result, or an explicit period and dimension values.
 */
const queriesRecords = authed
  .input(
    z.object({
      queryRunId: Id,
      /** A row of the run's result (an answer's chart point): its period and groups are the click. */
      row: z.number().int().min(0).max(99).optional(),
      /** Or the click itself: a period's first day and the dimensions' values. */
      group: z
        .object({
          time: z.string().max(40).optional(),
          values: z
            .record(z.string().max(100), z.union([z.string().max(300), z.number(), z.boolean(), z.null()]))
            .optional(),
        })
        .optional(),
      page: z.number().int().min(0).max(19).default(0),
      pageSize: z.number().int().min(1).max(50).optional(),
      /** The number clicked, so the list can say whether it adds up to it. */
      expected: z.number().nullable().optional(),
    }),
  )
  .output(z.custom<RecordsAnswer>());

/** Feedback on an answer (👍/👎 with a reason), or on one of its numbers ("this is wrong"). */
const feedbackGive = authed
  .errors({ NOT_FOUND })
  .input(
    z.object({
      runId: Id,
      queryRunId: Id.optional(),
      claimKey: z.string().max(200).optional(),
      kind: z.enum(["up", "down", "wrong_number"]),
      reasonCode: z.enum(REASONS).optional(),
      comment: z.string().max(2000).optional(),
      correction: z.string().max(2000).optional(),
    }),
  )
  .output(
    z.object({
      id: Id,
      /**
       * A thumbs down that said what was wrong: kept as the person's memory and a learning for the team
       * (a draft guide before it).
       */
      correction: z
        .object({
          text: z.string(),
          memory: z.object({ fact: z.string() }).nullable(),
          guideId: Id.nullable(),
          learningId: Id.nullable().optional(),
        })
        .optional(),
    }),
  );

/** Takes back one's thumbs on an answer. */
const feedbackWithdraw = authed.input(z.object({ runId: Id })).output(z.object({ withdrawn: z.boolean() }));

/** What one has said about an answer, for its buttons. */
const feedbackMine = authed.input(z.object({ runId: Id })).output(z.custom<MyFeedback>());

/**
 * Learnings: the ones a correction under this answer opened or joined (every one for an owner or admin, the
 * caller's own otherwise), and the workspace's for its owners and admins.
 */
const learningForRun = authed.input(z.object({ runId: Id })).output(z.array(z.custom<LearningCard>()));
const learningList = authed.output(z.array(z.custom<LearningCard>()));
/** One tap, Revert, Reject: an owner's or admin's. */
const learningApprove = authed
  .errors({ NOT_FOUND })
  .input(z.object({ id: Id }))
  .output(z.object({ approved: z.boolean() }));
const learningRevert = authed
  .errors({ NOT_FOUND, INVALID })
  .input(z.object({ id: Id }))
  .output(z.object({ reverted: z.boolean() }));
const learningReject = authed
  .errors({ NOT_FOUND })
  .input(z.object({ id: Id, note: z.string().max(500).optional() }))
  .output(z.object({ rejected: z.boolean() }));
/** "Suggest for the team": someone shares their own correction, kept as their memory. */
const learningSuggest = authed
  .errors({ NOT_FOUND })
  .input(z.object({ memoryId: Id }))
  .output(z.object({ proposalId: Id }));

/** An approver's change to a learning before the tap: checked and tested again, then waiting for their tap. */
const learningEdit = authed
  .errors({ NOT_FOUND, INVALID })
  .input(
    z.object({
      id: Id,
      means: z.string().trim().min(1).max(300).optional(),
      column: z.string().trim().max(400).nullable().optional(),
      values: z.array(z.string().trim().max(120)).max(10).optional(),
      synonyms: z.array(z.string().trim().max(80)).max(12).optional(),
      not: z.array(z.string().trim().max(400)).max(10).optional(),
    }),
  )
  .output(z.object({ edited: z.boolean() }));

/** What OpenDash learns of a source: every table, ranked, with what's picked (owners and admins). */
const sourcesLearning = authed
  .errors({ NOT_FOUND })
  .input(z.object({ connectionId: Id }))
  .output(z.custom<LearningChoice>());

/** Saves what's learned: the tables named are learned, the rest known; a sync learns the new ones. */
const sourcesChooseLearned = authed
  .errors({ NOT_FOUND, INVALID })
  .input(z.object({ connectionId: Id, tables: z.array(z.string().max(400)).min(1).max(2000) }))
  .output(z.object({ learned: z.number(), syncRunId: Id }));
/**
 * Make this a metric: a Modeler run drafting a metric from an answer's query. Returns the draft's proposal
 * and where it is (a draft under way or in review is the one there is).
 */
const proposalsRequest = authed
  .errors({ NOT_FOUND, INVALID })
  .input(z.object({ queryRunId: Id }))
  .output(z.object({ proposalId: Id, status: z.string() }));

/**
 * Draft definitions: a Modeler run drafts datasets and metrics for up to 10 of a source's tables and views, for
 * review in Knowledge → Proposals. Owners and admins; the run already drafting on the source when there is one.
 */
const proposalsDraftSource = authed
  .errors({ NOT_FOUND, INVALID })
  .input(z.object({ connectionId: Id, tables: z.array(z.string().min(1).max(512)).min(1).max(10) }))
  .output(z.object({ proposalId: Id, status: z.string() }));

/** An eval run as the API lists it: with the name of who started it. */
export type EvalRunListing = EvalRunSummary & { requester: string | null };

/** Knowledge → Evals: the suite, each case's last result, the recent runs. Owners and admins. */
const evalsOverview = authed.output(z.custom<Omit<EvalOverview, "runs"> & { runs: EvalRunListing[] }>());

/** One run: every case it checks, failed first. Owners and admins. */
const evalsRun = authed
  .errors({ NOT_FOUND })
  .input(z.object({ evalRunId: Id }))
  .output(z.custom<EvalRunListing & { results: EvalResultView[] }>());

/** Run now: one run at a time; the analyst answers every case (about three model calls each). Owners and admins. */
const SPEND_LIMIT = { message: "A spend limit for AI was reached." };

const evalsStart = authed
  .errors({ RUN_ACTIVE: { message: "A run is already going. Wait for it to finish." }, SPEND_LIMIT })
  .output(z.object({ evalRunId: Id }));

/** Turns the nightly run (03:00 UTC) on or off. Owners and admins. */
const evalsSetNightly = authed.input(z.object({ nightly: z.boolean() })).output(z.object({ nightly: z.boolean() }));

const Kind = z.enum(PROVIDER_KINDS);

/**
 * The models a person can ask with (the composer's picker): by provider, the thinking levels, and the
 * default. Owners and admins also get the providers set up that aren't working (`manage`); for everyone else it's null.
 */
const aiModels = authed.output(
  z.custom<Omit<OfferedModels, "notWorking"> & { manage: { notWorking: string[] } | null }>(),
);

/** Settings → AI: every kind of provider, what each offers and who's billed, and the default. Admins. */
const aiSettingsGet = authed.output(z.custom<AiSettingsView>());

/**
 * A provider's credentials as typed, tested before anything is saved: checked, sealed at once, tested by
 * the worker, never returned. Admins.
 */
const aiTestProvider = authed
  .errors({ INVALID })
  .input(
    z.object({
      kind: Kind,
      credentials: z
        .record(z.string().max(40), z.string().max(16_384))
        .refine((c) => Object.keys(c).length <= 10, { message: "Too many settings." }),
    }),
  )
  .output(z.object({ testId: Id }));

/** A test's result, while the dialog waits on it. Admins. */
const aiProviderTest = authed
  .errors({ NOT_FOUND })
  .input(z.object({ testId: Id }))
  .output(z.custom<ProviderTestView>());

/** Set up (or replace) a provider from a test that passed, with the models people can pick from it. Admins. */
const aiSaveProvider = authed
  .errors({ NOT_FOUND, INVALID })
  .input(z.object({ kind: Kind, testId: Id, picked: z.array(z.string().max(80)).max(40) }))
  .output(z.object({ ok: z.literal(true) }));

/** Removes a provider and its credentials, or tests them again. Admins. */
const aiRemoveProvider = authed
  .errors({ NOT_FOUND, INVALID })
  .input(z.object({ kind: Kind }))
  .output(z.object({ ok: z.literal(true) }));
const aiRetestProvider = authed
  .errors({ NOT_FOUND, INVALID })
  .input(z.object({ kind: Kind }))
  .output(z.object({ ok: z.literal(true) }));

/** Which of a provider's models people can pick, and (OpenDash) whether it's on. Admins. */
const aiSetProviderModels = authed
  .errors({ NOT_FOUND, INVALID })
  .input(z.object({ kind: Kind, picked: z.array(z.string().max(80)).max(40), enabled: z.boolean().optional() }))
  .output(z.object({ ok: z.literal(true) }));

/** The default: a model people can pick, the provider it runs on, and its level. Admins. */
const aiSetDefault = authed
  .errors({ INVALID })
  .input(z.object({ model: z.string().max(80), provider: Kind, reasoning: z.enum(LEVEL_IDS) }))
  .output(z.custom<ModelChoice>());

/** Settings → Usage's limits: this month's and today's spend against them. Owners and admins. */
const usageLimits = authed.output(z.custom<SpendView>());
const usageSetLimits = authed
  .errors({ INVALID })
  .input(
    z.object({
      monthlyUsd: z.number().positive().max(1_000_000).nullable(),
      dailyUsd: z.number().positive().max(1_000_000).nullable(),
      /** Background work's monthly budget (0: off); left out, it stays as it is. */
      backgroundMonthlyUsd: z.number().min(0).max(1_000_000).optional(),
      /** Where a person's run pauses and asks to continue (null: none); left out, it stays as it is. */
      runCeilingUsd: z.number().positive().max(10_000).nullable().optional(),
    }),
  )
  .output(z.custom<SpendView>());

// ---- Connections (MCP) ---------------------------------------------------------------------------------------------

const ServerId = z.object({ serverId: Id });
const Tier = z.enum(["always", "ask", "blocked"]);
const EnteredClient = z.object({
  clientId: z.string().min(1).max(500),
  clientSecret: z.string().max(2_000).nullable().optional(),
  issuer: z.string().max(500),
});
const OK = z.object({ ok: z.literal(true) });

/** Settings → Connections: every server approved here, with counts of people's own connections. Admins. */
const mcpServers = authed.errors({ INVALID }).output(z.array(z.custom<mcp.ServerView>()));
/** One server's page: how it signs in, whose account it uses, and its tools. Admins. */
const mcpServer = authed.errors({ NOT_FOUND, INVALID }).input(ServerId).output(z.custom<mcp.ServerDetail>());
/** How a server at this address signs people in, found before it's approved; nothing is stored. Admins. */
const mcpDetect = authed
  .errors({ INVALID })
  .input(z.object({ url: z.string().min(1).max(2_000) }))
  .output(z.custom<mcp.Detection>());
/** Approves a server as detected, with whose account it uses and who may use it. Admins. */
const mcpApprove = authed
  .errors({ INVALID })
  .input(
    z.object({
      name: z.string().min(1).max(80),
      url: z.string().min(1).max(2_000),
      auth: z.enum(["oauth", "apikey", "none"]),
      transport: z.enum(["streamable", "sse"]),
      access: z.enum(["personal", "shared"]),
      dashboardsAllowed: z.boolean(),
      client: EnteredClient.nullable().optional(),
      keyHeader: z.string().max(64).nullable().optional(),
      keyFormat: z.string().max(100).nullable().optional(),
      keyHint: z.string().max(300).nullable().optional(),
    }),
  )
  .output(z.object({ id: Id }));
/** Changes a server: its name, whose account, dashboards, on or off, its key's header and hint, its client. Admins. */
const mcpUpdate = authed
  .errors({ NOT_FOUND, INVALID })
  .input(
    ServerId.extend({
      name: z.string().min(1).max(80).optional(),
      access: z.enum(["personal", "shared"]).optional(),
      dashboardsAllowed: z.boolean().optional(),
      status: z.enum(["active", "disabled"]).optional(),
      transport: z.enum(["streamable", "sse"]).optional(),
      keyHeader: z.string().max(64).nullable().optional(),
      keyFormat: z.string().max(100).nullable().optional(),
      keyHint: z.string().max(300).nullable().optional(),
      client: EnteredClient.nullable().optional(),
    }),
  )
  .output(OK);
/** Removes a server with every connection to it (everyone's) and their secrets. Admins. */
const mcpRemove = authed.errors({ NOT_FOUND, INVALID }).input(ServerId).output(OK);
/**
 * Lists a server's tools again through the admin's session (their own account, the shared one, or none), and records
 * what changed; or the state that kept it from listing (connect, reconnect, …). Admins.
 */
const mcpListTools = authed
  .errors({ NOT_FOUND, INVALID })
  .input(ServerId)
  .output(z.custom<mcp.ListedTools | Exclude<mcp.McpOutcome, { state: "ready" }>>());
/** A tool's tier, whether dashboards may use it, or that an admin reviewed a change. Admins. */
const mcpSetTool = authed
  .errors({ NOT_FOUND, INVALID })
  .input(
    ServerId.extend({
      name: z.string().min(1).max(200),
      tier: Tier.optional(),
      dashboardsAllowed: z.boolean().optional(),
      reviewed: z.literal(true).optional(),
    }),
  )
  .output(OK);
/** Settings → My connections: every server on here, with the person's own account where it's theirs. Everyone. */
const mcpMine = authed.errors({ INVALID }).output(z.array(z.custom<mcp.MyConnection>()));
/** Starts signing in: where to send the person (a window, or the page). Their own, or (admins) everyone's. */
const mcpConnect = authed
  .errors({ NOT_FOUND, INVALID })
  .input(ServerId)
  .output(z.object({ authorizationUrl: z.string(), expiresAt: z.date() }));
/** Removes the person's own account (or, admins, the one everyone uses). */
const mcpDisconnect = authed
  .errors({ NOT_FOUND, INVALID })
  .input(ServerId)
  .output(z.object({ removed: z.boolean() }));
/** A key, tested (its tools listed, nothing called) before it's kept: the person's own, or (admins) everyone's. */
const mcpPutKey = authed
  .errors({ NOT_FOUND, INVALID })
  .input(ServerId.extend({ key: z.string().min(1).max(4_200) }))
  .output(z.custom<mcp.PutKey>());

// ---- Dashboards ----------------------------------------------------------------------------------------------------

const DashboardId = z.object({ dashboardId: Id });
const Revision = z.string().regex(/^[0-9a-f]{64}$/);
const FilterValues = z.record(
  z.string().regex(/^f_[a-z0-9_]{1,40}$/),
  z.union([z.string().max(40), z.array(z.string().max(200)).max(100)]),
);
/** A grid's condition on one of its columns: the server checks the column and operator against the definition. */
const Cell = z.union([z.string().max(200), z.number()]);
const Condition = z.union([
  z.tuple([
    z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/),
    z.enum(["in", "contains", ">=", "<=", "<"]),
    z.union([Cell, z.array(Cell).max(50)]),
  ]),
  z.tuple([z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/), z.literal("is null")]),
]);
const Conditions = z.array(Condition).max(8);
const AskBase = {
  id: z.string().min(1).max(200),
  at: z.string().max(40).optional(),
  filters: FilterValues.optional(),
  /** The record the App shows: its key (the server checks the query takes one). */
  record: z.union([z.string().min(1).max(200), z.number()]).optional(),
};
/** The App's query a grid draws (its totals, work and actions are the query's). */
const QueryId = z.string().regex(/^q_[a-z0-9_]{1,40}$/);
/** One of the App's summaries. */
const SummaryId = z.string().regex(/^s_[a-z0-9_]{1,40}$/);

/**
 * What a frame asks for: a named query (a page, a sort, a page size and conditions for rows), a number's rows through
 * its drill query, a filter's values from the warehouse, a column's values with counts, or a query's totals.
 */
const DashboardRequest = z.union([
  z.object({
    ...AskBase,
    query: z.string().regex(/^q_[a-z0-9_]{1,40}$/),
    page: z.int().min(0).max(10_000).optional(),
    sort: z.string().max(64).optional(),
    pageSize: z.int().min(5).max(500).optional(),
    where: Conditions.optional(),
    search: z.string().max(100).optional(),
  }),
  z.object({ ...AskBase, lookup: z.string().regex(/^f_[a-z0-9_]{1,40}$/), search: z.string().max(120).optional() }),
  z.object({
    ...AskBase,
    facet: z.object({
      query: z.string().regex(/^q_[a-z0-9_]{1,40}$/),
      column: z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/),
    }),
    where: Conditions.optional(),
    search: z.string().max(120).optional(),
  }),
  z.object({ ...AskBase, totals: QueryId, where: Conditions.optional() }),
  z.object({
    ...AskBase,
    drill: z.string().regex(/^q_[a-z0-9_]{1,40}$/),
    group: z.record(z.string().max(80), z.union([z.string().max(200), z.number(), z.null()])).optional(),
    page: z.int().min(0).max(10_000).optional(),
    /** A service's number: the read it was made from. */
    pin: z.uuid().optional(),
  }),
]);

/** A dashboard as its page shows it: its frame's signed link, and for its owner, their draft's. */
export type DashboardPage = dashboards.DashboardView & {
  owner: string | null;
  frameUrl: string | null;
  draftFrameUrl: string | null;
};
export type DashboardListing = dashboards.DashboardSummary & { owner: string | null };

/** The dashboards the caller reads; with a conversation, those built in it. */
const dashboardsList = authed
  .input(z.object({ threadId: Id.optional() }).optional())
  .output(z.array(z.custom<DashboardListing>()));
const dashboardsGet = authed.errors({ NOT_FOUND }).input(DashboardId).output(z.custom<DashboardPage>());
/**
 * A frame's requests under the revision it draws: each answered, queued (ask again with its `at`), refused with why,
 * or busy for the moment. NOT_FOUND when the caller doesn't read that revision.
 */
const dashboardsQuery = authed
  .errors({ NOT_FOUND })
  .input(
    z.object({
      dashboardId: Id,
      revision: Revision,
      // MAX_BATCH in @opendash/apps/protocol (the frame splits its asks to fit).
      requests: z.array(DashboardRequest).min(1).max(16),
      retry: z.boolean().optional(),
    }),
  )
  .output(z.array(z.custom<dashboards.DashboardAnswer>()));
/**
 * Working in a dashboard's list: the work on these records (owner, status, note, follow-up), the
 * people a record can be given to, and whether this person may change it; with `set`, a change to one record.
 */
const dashboardsWork = authed
  .errors({ NOT_FOUND, INVALID: { message: "That can't be saved." } })
  .input(
    z.object({
      dashboardId: Id,
      revision: Revision,
      section: QueryId,
      keys: z.array(z.string().max(200)).max(200).default([]),
      /** The read the list shows (a list read with each person's own account): keys are checked against it. */
      snapshot: z.uuid().optional(),
      /** A record whose history to read too. */
      history: z.string().min(1).max(200).optional(),
      set: z
        .object({
          key: z.string().min(1).max(200),
          ownerId: Id.nullable().optional(),
          status: z.string().max(40).nullable().optional(),
          note: z.string().max(2000).nullable().optional(),
          followUp: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .nullable()
            .optional(),
        })
        // A change names at least one field (null clears one): an empty one would be a write that's never counted.
        .refine((s) => [s.ownerId, s.status, s.note, s.followUp].some((v) => v !== undefined), {
          message: "Say what changes: an owner, a status, a note or a follow-up.",
        })
        .optional(),
    }),
  )
  .output(
    z.object({
      work: z.array(z.custom<dashboards.RecordWork>()),
      people: z.array(z.object({ id: z.string(), name: z.string() })),
      canWork: z.boolean(),
      history: z.array(z.custom<dashboards.WorkEvent>()).optional(),
    }),
  );
/**
 * A row's action: prepared (what will be sent, as a ticket that lasts two minutes), then run by its ticket
 * once the person confirms on OpenDash's own dialog. Nothing but ids and the row's key comes from the page.
 */
const dashboardsAction = authed
  .errors({ NOT_FOUND, INVALID })
  .input(
    z.object({
      dashboardId: Id,
      revision: Revision,
      section: QueryId,
      action: z.string().regex(/^a_[a-z0-9_]{1,40}$/),
      key: z.union([z.string().min(1).max(200), z.number()]),
      /** The read the page shows (a service's list): the key must be in it. */
      snapshot: z.uuid().optional(),
    }),
  )
  .output(z.custom<dashboards.PreparedAction>());
const dashboardsActionRun = authed
  .errors({ NOT_FOUND, INVALID })
  .input(z.object({ ticket: z.uuid() }))
  .output(z.custom<dashboards.ActionOutcome>());
/** A summary's words: the note written from its numbers now, or (with write) asked to be written. */
const dashboardsSummary = authed
  .errors({ NOT_FOUND })
  .input(
    z.object({
      dashboardId: Id,
      revision: Revision,
      section: SummaryId,
      filters: z
        .record(z.string().max(48), z.union([z.string().max(200), z.array(z.string().max(200)).max(100)]))
        .default({}),
      write: z.boolean().optional(),
      again: z.boolean().optional(),
      /** A rewrite's angle: one of a fixed few (never text). */
      angle: z.enum(["fresh", "lead", "short", "email"]).optional(),
    }),
  )
  .output(z.custom<dashboards.SummaryAnswer>());
const dashboardsVersions = authed
  .errors({ NOT_FOUND })
  .input(DashboardId)
  .output(
    z.array(
      z.object({ version: z.number(), createdAt: z.string(), changeNote: z.string().nullable(), by: z.string() }),
    ),
  );
/** Its owner restores a version: checked as it would be saved today, and the next version if it passes. */
const dashboardsRestore = authed
  .errors({ NOT_FOUND, INVALID })
  .input(DashboardId.extend({ version: z.int().min(1), expectedVersion: z.int().min(0) }))
  .output(z.object({ version: z.number() }));
/**
 * What the owner's browser measured of their draft at one width (the render check): kept for the
 * revision the draft holds now, read by the analyst before it says the App is done.
 */
const dashboardsRenderCheck = authed
  .errors({ NOT_FOUND })
  .input(
    DashboardId.extend({
      revision: z.string().min(1).max(100),
      width: z.number().int().min(200).max(4000),
      findings: z.array(z.unknown()).max(40),
      unsettled: z.boolean().optional(),
    }),
  )
  .output(z.object({ kept: z.boolean() }));

/**
 * How one open of an App went in the person's browser: when it drew and when its first and its last answer landed (in
 * milliseconds since its page showed it), the frame's own first moments, and how its answers were asked for. Logged as
 * one line, never stored: what makes "it's slow" a number (it was once measured by hand from two logs).
 */
const OpenMs = z.number().int().min(0).max(600_000);
const dashboardsOpened = authed
  .input(
    DashboardId.extend({
      drawn: OpenMs.optional(),
      answer: OpenMs.optional(),
      answers: OpenMs.optional(),
      /** In the frame's own time, since it started loading: its runtime ran, its document loaded. */
      frame: z.object({ runtime: OpenMs.optional(), loaded: OpenMs.optional() }).optional(),
      asked: z.number().int().min(0).max(10_000),
      rounds: z.number().int().min(0).max(1_000),
      looks: z.number().int().min(0).max(10_000),
      /** The slowest query's time in the warehouse. */
      slowest: OpenMs.optional(),
    }),
  )
  .output(z.object({ logged: z.boolean() }));

/** Which of a run's dashboards its change can still be undone on: what the button is offered for. */
const dashboardsUndoable = authed
  .input(z.object({ runId: Id, dashboardIds: z.array(Id).max(20) }))
  .output(z.array(z.string()));
/**
 * Its owner undoes what an analyst's run changed in the draft ("Undo these changes"): the draft as it was
 * before, or none. INVALID when it changed since (another save, a publish): nothing is written over newer work.
 */
const dashboardsUndo = authed
  .errors({ NOT_FOUND, INVALID })
  .input(DashboardId.extend({ runId: Id }))
  .output(z.object({ revision: z.string().nullable() }));
/** Its owner publishes the draft they see (its revision) as the next version. */
const dashboardsPublish = authed
  .errors({ NOT_FOUND, INVALID })
  .input(DashboardId.extend({ revision: z.string().regex(/^[0-9a-f]{64}$/) }))
  .output(z.object({ version: z.number() }));
const dashboardsShare = authed
  .errors({ NOT_FOUND, INVALID })
  .input(DashboardId.extend({ visibility: z.enum(["private", "project", "org"]) }))
  .output(z.object({ visibility: z.enum(["private", "project", "org"]) }));
const ShareRole = z.enum(["view", "edit"]);
/**
 * Who its owner shares it with by name (View / Can edit), on top of who its visibility covers, and the workspace's
 * members they can add (found by name or address; a workspace viewer only ever to view). Its owner's to see.
 */
const dashboardsShares = authed
  .errors({ NOT_FOUND })
  .input(DashboardId)
  .output(
    z.object({
      people: z.array(
        z.object({ userId: z.string(), name: z.string(), email: z.string(), role: ShareRole, addedAt: z.string() }),
      ),
      members: z.array(z.object({ userId: z.string(), name: z.string(), email: z.string(), viewer: z.boolean() })),
    }),
  );
/** Its owner shares it with one member, changes what they may do, or (role null) stops sharing it with them. */
const dashboardsSharePerson = authed
  .errors({ NOT_FOUND, INVALID })
  .input(DashboardId.extend({ userId: Id, role: ShareRole.nullable() }))
  .output(z.object({ role: ShareRole.nullable() }));
const dashboardsDelete = authed
  .errors({ NOT_FOUND })
  .input(DashboardId)
  .output(z.object({ deleted: z.boolean() }));
const dashboardsStar = authed
  .errors({ NOT_FOUND })
  .input(DashboardId.extend({ starred: z.boolean() }))
  .output(z.object({ starred: z.boolean() }));

export const contract = {
  mcp: {
    servers: mcpServers,
    server: mcpServer,
    detect: mcpDetect,
    approve: mcpApprove,
    update: mcpUpdate,
    remove: mcpRemove,
    listTools: mcpListTools,
    setTool: mcpSetTool,
    mine: mcpMine,
    connect: mcpConnect,
    disconnect: mcpDisconnect,
    putKey: mcpPutKey,
  },
  dashboards: {
    list: dashboardsList,
    get: dashboardsGet,
    query: dashboardsQuery,
    summary: dashboardsSummary,
    work: dashboardsWork,
    action: dashboardsAction,
    actionRun: dashboardsActionRun,
    versions: dashboardsVersions,
    restore: dashboardsRestore,
    undo: dashboardsUndo,
    undoable: dashboardsUndoable,
    renderCheck: dashboardsRenderCheck,
    opened: dashboardsOpened,
    publish: dashboardsPublish,
    share: dashboardsShare,
    shares: dashboardsShares,
    sharePerson: dashboardsSharePerson,

    delete: dashboardsDelete,
    star: dashboardsStar,
  },
  sources: {
    askable: sourcesAskable,
    suggestions: sourcesSuggestions,
    readiness: sourcesReadiness,
    learning: sourcesLearning,
    chooseLearned: sourcesChooseLearned,
  },
  threads: { list: threadsList, get: threadsGet, share: threadsShare, star: threadsStar },
  ask: { submit: askSubmit, attachable: askAttachable, takeBack: askTakeBack, readReference: askReadReference },
  runs: { events: runsEvents, stop: runsStop, trace: runsTrace, step: runsStep, recent: runsRecent },
  queries: { get: queriesGet, records: queriesRecords },
  feedback: { give: feedbackGive, withdraw: feedbackWithdraw, mine: feedbackMine },
  learning: {
    forRun: learningForRun,
    list: learningList,
    approve: learningApprove,
    revert: learningRevert,
    reject: learningReject,
    edit: learningEdit,
    suggest: learningSuggest,
  },
  proposals: { request: proposalsRequest, draftSource: proposalsDraftSource },
  evals: { overview: evalsOverview, run: evalsRun, start: evalsStart, setNightly: evalsSetNightly },
  usage: { limits: usageLimits, setLimits: usageSetLimits },
  ai: {
    models: aiModels,
    settings: aiSettingsGet,
    testProvider: aiTestProvider,
    providerTest: aiProviderTest,
    saveProvider: aiSaveProvider,
    removeProvider: aiRemoveProvider,
    retestProvider: aiRetestProvider,
    setProviderModels: aiSetProviderModels,
    setDefault: aiSetDefault,
  },
};
export type Contract = typeof contract;
export type { RunView };

/** HTTP statuses for the contract's errors (v2 keeps them out of the contract): one map for every handler. */
export const ERROR_STATUS_MAP = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  RUN_ACTIVE: 409,
  INVALID: 422,
  SPEND_LIMIT: 429,
  TOO_MANY_READS: 429,
} as const;

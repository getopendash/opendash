/**
 * What a tool is: a name, the description and Zod schema the model reads, and a body over our own code
 * (core, the gateway, Postgres). The body gets the run's context: the model never names an organization, a source or
 * a person; those come from the run it belongs to. The runner wraps every body in the ledger (exactly once, after its
 * message is saved, fenced by the attempt).
 */
import type { Dialect } from "@opendash/connectors";
import type { ClaimedRun, GatewayDeps, LoadedModel, ReleasedGuide, ReleasedTerm } from "@opendash/core";
import type { z } from "zod";
import type { AgentDeps } from "../harness/deps";
import type { CatalogTable } from "../instructions/catalog";
import type { SourceRegistry } from "./sources";

/** A source a run reads, as the analyst reads it. */
export interface RunSource {
  connectionId: string;
  name: string;
  dialect: Dialect;
  tables: CatalogTable[];
  /** The source's verified definitions, or null when it has none. */
  semantic: LoadedModel | null;
}

/** What the run counts while it goes; the runner reads it to wrap up (and an agent's budget, to stop). */
export interface RunState {
  failedQueries: number;
  /** Queries run (sql_query, metric_query). */
  queries: number;
  /** Tool calls run (a redelivered one, already recorded, isn't counted again). */
  toolCalls: number;
  /** The run's model calls' cost so far, in dollars (priced models). */
  costUsd: number;
}

export interface ToolContext {
  deps: AgentDeps;
  run: ClaimedRun;
  /** The source the question starts from (`sources.main`). */
  source: RunSource;
  /** Every source the run can read; tools that take `source` pick from it. */
  sources: SourceRegistry;
  /** The glossary and guides an admin approved, given to this run. */
  context: { terms: ReleasedTerm[]; pinned: ReleasedGuide[]; anchored: ReleasedGuide[] };
  /** What the answer gate lets an answer echo: the glossary's defining values. */
  definitions: string;
  /** The numbers in the asker's files: an answer may repeat one as theirs, saying so. */
  askerNumbers?: string;
  /** The person who asked (their memory, their own connected accounts), or null for evals and background runs. */
  asker: string | null;
  gateway: GatewayDeps;
  requester: { type: "run"; id: string };
  state: RunState;
  /**
   * The attempt the tool runs in, for a tool that runs a child run in it: its worker, the worker's shutdown
   * signal, its dollar cap, and how long it has left before it must wrap up. `raise` gives the run a bigger budget from
   * now on (never a smaller one): an analyst run that starts building an App gets the build budget.
   */
  attempt: {
    workerId: string;
    drain?: AbortSignal;
    maxCostUsd: number;
    timeLeftMs: () => number;
    raise?: (to: RaisedLimits) => void;
  };
}

/** A run's budget and time, raised once mid-run. */
export interface RaisedLimits {
  maxSteps: number;
  maxToolCalls: number;
  maxQueries: number;
  maxCostUsd: number;
  wallMs: number;
  wrapUpAtMs: number;
}

/** What's recorded of a call a run resumes: whether it was interrupted, or the result it returned. */
export interface Recorded {
  interrupted: boolean;
  result?: unknown;
}

/** A tool body's result: what the model is shown, and what the ledger records with it. */
export interface ToolResult {
  value: unknown;
  queryRunId?: string;
  /** What the run's steps show, never shown to the model. */
  summary?: Record<string, unknown>;
}

/**
 * What a tool's call does to the world, recorded on its `tool_call` row: `read` changes nothing; `internal`
 * changes something in OpenDash (a memory, a proposal, the run's own ending); `compute` and `external`
 * aren't built yet. An agent's kind limits which it may have (harness/agent.ts).
 */
export type EffectClass = "read" | "compute" | "internal" | "external";

/**
 * How long a tool's work takes, which sets its timeout (harness/limits.ts): `quick` reads OpenDash's own data, `query`
 * runs one query on a source, `slow` tests on the data (each draft's checks), `child` runs
 * a child run to its end (a drafter's group, bounded by its own time too). A tool that runs out of time is
 * stopped through its signal, and the model is told so.
 */
export type ToolTime = "quick" | "query" | "slow" | "child";

export interface AgentTool<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  effect: EffectClass;
  /** Its timeout's class; quick when not said. */
  time?: ToolTime;
  schema: S;
  /**
   * Lists the model may leave out, read as empty (harness/repair.ts): the answer's caveats. Only lists whose absence
   * says nothing: never one that records what was applied, like the answer's interpretation.
   */
  emptyWhenMissing?: string[];
  /**
   * A call whose work can be picked up again (a drafter left unfinished). When a run resumes, before its next
   * model call, each of its calls this says is still owed runs again with the same input, and what it returns reaches
   * the model as a report: picking it up is the harness's job, never left to the model. Its execute must be safe to run
   * again: it continues the same work. Only calls that were admitted are asked (never one the harness refused or that
   * failed for a reason of its own), with what's recorded of them: interrupted (no result, or the run ended under it),
   * or the result it returned.
   */
  resume?: {
    owed(input: z.infer<S>, ctx: ToolContext, recorded: Recorded): Promise<boolean>;
    /** The work a call stands for, so calls for the same work, written differently, are reported once. */
    key?(input: z.infer<S>): string;
  };
  execute(input: z.infer<S>, ctx: ToolContext, call: { rowId: string; signal: AbortSignal }): Promise<ToolResult>;
}

export const defineTool = <S extends z.ZodType>(tool: AgentTool<S>): AgentTool<S> => tool;

import type { Embedder, GatewayDeps, Level, mcp, ProviderKind, RunOutcome } from "@opendash/core";
import type { TenantTx } from "@opendash/db";
import type { PgBoss } from "pg-boss";
import type { ResolvedModel } from "./model";

export interface AgentDeps extends GatewayDeps {
  /**
   * The run's model: a provider instance built for this org and run (never a bare model id string), its provider's
   * settings, and whose key pays. Throws ModelUnavailable when it can't run at all.
   */
  model: (run: {
    orgId: string;
    runId: string;
    modelId: string;
    /** The provider it runs on, by kind; OpenDash when not given. */
    provider?: ProviderKind;
    /** How long it thinks; Auto when not given. */
    reasoning?: Level;
  }) => Promise<ResolvedModel>;
  /**
   * The organization's embedder (vectors), for searching what's approved by meaning: null, or absent, searches by
   * words alone.
   */
  embedder?: (orgId: string) => Promise<Embedder | null>;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
  /**
   * The job queue: a run that ends with a follow-up still queued starts the next run with it. Without it,
   * that run is created and waits for whoever runs it (tests).
   */
  boss?: PgBoss | null;
  now?: () => Date;
  /** The waits for a busy provider within an attempt, for every run on these deps (tests shorten or skip them). */
  busyWaitsMs?: number[];
  /**
   * A transaction carrying the asker's user id, for their personal memory (the tenant policy shows a person their own
   * only). Without it, a run reads and keeps no memory.
   */
  withUser?: <T>(orgId: string, userId: string, fn: (tx: TenantTx) => Promise<T>) => Promise<T>;
  /** Connected services (MCP): reaching servers and their accounts. Absent: the analyst isn't offered them. */
  mcp?: mcp.McpDeps;
}

/**
 * How an attempt ended: the run with its outcome; handed off at a step boundary because the worker is shutting down
 * (the job runs again, and this attempt isn't a failure); or null when it wasn't claimed (it had ended, or a newer
 * attempt owns it).
 */
export type AttemptResult =
  | { status: "succeeded" | "failed" | "cancelled"; outcome: RunOutcome["kind"] }
  | { status: "handed_off" }
  | null;

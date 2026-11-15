/**
 * A connection check's shape, the same for every dialect: four steps the page shows as they run (reach,
 * sign in, can't change data, catalog), an outcome, and what was learned.
 */
import type { Edition } from "./network";

export type CheckKey = "reach" | "sign-in" | "read-only" | "catalog";
export type CheckStatus = "pending" | "running" | "ok" | "warn" | "fail" | "skipped";

/** One step of a check or a sync, as the UI shows it (Check Row). */
export interface Step<K extends string = string> {
  key: K;
  status: CheckStatus;
  label: string;
  detail?: string;
}

export type Check = Step<CheckKey>;

/**
 * passed: safe to connect. warning: the user can change data; connecting needs an explicit override.
 * blocked: the user is too powerful to use at all (superuser and the like); no override. failed: couldn't check.
 */
export type ProbeOutcome = "passed" | "warning" | "blocked" | "failed";

export interface ProbeFacts {
  user?: string;
  serverVersion?: string;
  ssl?: boolean;
  latencyMs?: number;
  blockedBy?: string[];
  writableTables?: number;
  /** The database carries OpenDash's sample-data marker (a comment written by `pnpm demo:seed`). */
  sampleData?: boolean;
  writePrivileges?: string[];
  tables?: number;
  schemas?: number;
  columns?: number;
}

export interface ProbeResult {
  outcome: ProbeOutcome;
  checks: Check[];
  facts: ProbeFacts;
  message?: string;
}

export interface ProbeOptions {
  edition: Edition;
  connectTimeoutMs: number;
  statementTimeoutMs: number;
  signal?: AbortSignal;
  /** Called after every step with the checks so far, so the UI can show progress. */
  onCheck?: (checks: Check[]) => Promise<void> | void;
}

/** The step bookkeeping both probes share: update a step and report progress, or stop at a failed one. */
export function stepper(checks: Check[], facts: ProbeFacts, onCheck: ProbeOptions["onCheck"]) {
  const report = () => onCheck?.(checks.map((c) => ({ ...c })));
  return {
    set: async (key: CheckKey, patch: Partial<Check>) => {
      const check = checks.find((c) => c.key === key);
      if (check) Object.assign(check, patch);
      await report();
    },
    stop: async (key: CheckKey, outcome: ProbeOutcome, message: string): Promise<ProbeResult> => {
      const check = checks.find((c) => c.key === key);
      if (check) Object.assign(check, { status: "fail", detail: message });
      for (const c of checks) if (c.status === "pending") c.status = "skipped";
      await report();
      return { outcome, checks, facts, message };
    },
  };
}

/**
 * One agent, its jobs: every run is OpenDash's agent doing one job, the job its
 * stored profile names. A job decides only capability, in code, checked once when it's defined (defineAgent): the tools
 * it may use, the tool that ends it, its budget, whether someone is waiting. Its method is its prompt (and, as the merge
 * goes on, a skill). A background job may change things only through its own ending or a child job.
 */
import type { AgentDefinition } from "../harness/agent";
import { analyst } from "./analyst";
import { composer } from "./composer";
import { curator } from "./curator";
import { investigator } from "./investigator";
import { modeler } from "./modeler";
import { drafter } from "./modeler/drafter";

/** The profiles a run can have (app.run's run_profile_check), each the job it is. */
export const JOBS = {
  analyst,
  investigator,
  modeler,
  drafter,
  curator,
  composer,
} as const satisfies Record<string, AgentDefinition>;

export type JobName = keyof typeof JOBS;

/** The job a run's profile names, or null for one no job has. */
export function jobFor(profile: string): AgentDefinition | null {
  return Object.hasOwn(JOBS, profile) ? JOBS[profile as JobName] : null;
}

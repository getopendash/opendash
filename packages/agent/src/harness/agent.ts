/**
 * An agent: what makes one different from another, read by the one loop every agent runs on
 * (run.ts: the claim, the ledger, the fence, the limits and the finish). An agent is a definition: its kind, every tool
 * it can be offered, how it prepares a run (its prompt's sections, the tools that run gets, what they read) and how it
 * ends. A new agent is one folder under agents/ with one `defineAgent`.
 */
import type { ClaimedRun, GivenRef, RunOutcome } from "@opendash/core";
import type { Sections } from "../instructions/compose";
import type { AgentTool, EffectClass, ToolContext } from "../tools/types";
import type { AgentDeps } from "./deps";

/**
 * What kind of work an agent does: who waits on it, and what its tools may change.
 *   - interactive: a person waits (the Analyst); it streams, and may change what that person asked it to;
 *   - background: nobody waits (the Investigator, the Reviewer); it reads, and changes nothing but its own ending;
 *   - drafting: an admin reviews its work later (the Modeler); it proposes, never applies.
 */
export type AgentKind = "interactive" | "background" | "drafting";

/** A budget of its own (the Investigator's 40 tool calls, 25 queries, $2). */
export interface AgentBudget {
  maxSteps: number;
  maxToolCalls: number;
  maxQueries: number;
  maxCostUsd: number;
}

/** A run made ready for the model: what it reads, and what its tools can use. */
export interface PreparedRun {
  /** The prompt's sections, each in its layer (instructions/compose.ts). */
  instructions: Sections;
  /** The tools this run is offered, in the order the model sees them: some of the agent's own. */
  tools: AgentTool[];
  /** What the tools read besides the run itself. */
  context: Pick<ToolContext, "source" | "sources" | "context" | "definitions" | "asker" | "askerNumbers">;
  /** This run's own budget, when it differs from the agent's (a Modeler run over tables grows with them). */
  budget?: AgentBudget;
  /** This run's own working time, when it differs from its kind's. */
  time?: { wallMs: number; wrapUpAtMs: number };
  /**
   * What goes with this run's question, besides its question layer: the verified queries like it, corrections reported
   * on the source. Stored, and sent with the question again on later questions. Never the asker's memory.
   */
  block?: string;
  /** The verified queries that block holds, by id and version: it's sent again only while each is still released so. */
  verified?: GivenRef[];
  /**
   * What goes with the whole conversation, after the source layer: what's attached to it and the asker's memory. Rebuilt
   * every run (attachments are checked again for whoever asks) and never stored; the record keeps what it held.
   */
  conversation?: {
    text: string;
    attached: GivenRef[];
    memories: number;
    /** The person's images: pictures sent with the question, never recorded in the prompt. */
    images?: { mediaType: string; data: string }[];
  };
  /**
   * This run's own words for wrapping up and for the nudge, when its tools differ from its agent's other runs' (a
   * Modeler leading a batch hands tables out; it proposes nothing): each names only the tools the run has.
   */
  ending?: { wrapUp: string; nudge: string };
  /**
   * A person's run that pauses instead of failing: at its dollar ceiling (null: none), or at the
   * end of a working slice (its time), it ends at a step boundary as paused, saying what it spent; "Continue" is the
   * person's next turn, which sees everything done. Its budget and time are the slice's, set beside it; nothing wraps
   * it up early for its cost or its time.
   */
  pause?: {
    ceilingUsd: number | null /** True when the workspace's limits leave less than its ceiling. */;
    byLimit?: boolean;
  };
}

export interface AgentDefinition {
  name: string;
  kind: AgentKind;
  /** Every tool it can be offered, in the order the model sees them; prepare picks those a run gets. */
  tools: AgentTool[];
  prepare(deps: AgentDeps, run: ClaimedRun): Promise<PreparedRun>;
  /** The run's outcome once it ended, read from the ledger (so a resumed attempt finds it too); null while it hasn't. */
  outcome(deps: AgentDeps, run: ClaimedRun): Promise<RunOutcome | null>;
  ending: {
    /** Whether the last step's results end the run. */
    reached(results: { toolName: string; output: unknown }[]): boolean;
    /** The tools left when the run has to wrap up (its budget nearly spent, or too many failures). */
    tools: string[];
    /** Added to the instructions while wrapping up. */
    wrapUp: string;
    /** Sent once when the model stops without ending the run. */
    nudge: string;
    /**
     * Why a run of this agent failed, in its words: it stopped without ending, spent its budget, ran out of time, or
     * its attempts kept failing.
     */
    stopped: { unfinished: string; budget: string; time: string; failing: string };
  };
  /** Its budget: the dollars are a hard stop; nearing any of them, the run wraps up (harness/limits.ts). */
  budget: AgentBudget;
  /**
   * Its tools that run a child run to its end (the Modeler's draft_tables), allowed beside its endings: what
   * a child changes goes through the child's own tools, which its own definition was checked with.
   */
  children?: string[];
}

/** Effects no tool has yet: compute runs isolated, and an external one comes with its effect ledger. */
const NOT_BUILT: EffectClass[] = ["compute", "external"];

/**
 * An agent, checked once when it's defined: its tools' names are unique, its ending tools are among them, none has an
 * effect not built yet, and outside a conversation every `internal` tool is one of its endings (or runs a child run,
 * itself checked so, on a child's time), so a background agent can never be given a tool that changes what people see.
 */
export function defineAgent(def: AgentDefinition): AgentDefinition {
  const names = def.tools.map((t) => t.name);
  const problem = (why: string) => new Error(`The ${def.name} agent: ${why}`);
  if (new Set(names).size !== names.length) throw problem("a tool is listed twice.");
  for (const t of def.ending.tools)
    if (!names.includes(t)) throw problem(`its ending tool ${t} isn't one of its tools.`);
  for (const t of def.children ?? [])
    if (!names.includes(t)) throw problem(`its child tool ${t} isn't one of its tools.`);
  for (const t of def.tools) {
    if (NOT_BUILT.includes(t.effect)) throw problem(`${t.name} is ${t.effect}, which no agent can have yet.`);
    const child = (def.children ?? []).includes(t.name);
    if (child && t.time !== "child") throw problem(`${t.name} runs a child run, so it needs a child's time.`);
    const allowed = def.ending.tools.includes(t.name) || child;
    if (def.kind !== "interactive" && t.effect === "internal" && !allowed) {
      throw problem(`${t.name} changes something, and a ${def.kind} agent may only end its own run.`);
    }
  }
  return def;
}

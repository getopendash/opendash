import type { ThreadState, ThreadSummary } from "@opendash/core";

type Tone = "default" | "running" | "warn" | "danger";

/** Each state's label and tone, in the conversations list's Status filter order. Core reads the state from the latest run. */
export const THREAD_STATE_LABELS: Record<ThreadState, { label: string; tone: Tone }> = {
  answered: { label: "Answered", tone: "default" },
  needs_input: { label: "Needs your input", tone: "warn" },
  cannot_answer: { label: "Not answered", tone: "warn" },
  working: { label: "Working…", tone: "running" },
  interrupted: { label: "Interrupted", tone: "danger" },
  stopped: { label: "Stopped", tone: "default" },
  none: { label: "No answer yet", tone: "default" },
};

/** How a conversation stands (the list's Status, the pane's subtitle). */
export const threadStatus = (t: Pick<ThreadSummary, "state">) => THREAD_STATE_LABELS[t.state];

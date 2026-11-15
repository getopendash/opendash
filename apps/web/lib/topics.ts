import type { TopicState } from "@opendash/core";

/** A topic's state as Knowledge → Learnings shows it. */
export const TOPIC_STATE: Record<
  TopicState,
  { label: string; color: "default" | "accent" | "success" | "warning" | "danger" }
> = {
  team: { label: "The team's", color: "success" },
  waiting: { label: "Waiting for a tap", color: "accent" },
  learning: { label: "Being learned", color: "accent" },
  proposed: { label: "Proposed", color: "default" },
  reverted: { label: "Reverted", color: "default" },
};

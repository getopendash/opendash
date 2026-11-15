import { Chip, Spinner } from "@heroui/react";
import type { SourceStatus, SourceSummary } from "@opendash/core";
import { CircleCheck, CircleMinus, CircleX, TriangleAlert } from "lucide-react";

type Tone = "success" | "warning" | "danger" | "accent" | "default";

/** The words and tone for a source's status (the sources list's Status column, the source header). */
export function statusLabel(s: Pick<SourceSummary, "status" | "learnedAt">): { label: string; tone: Tone } {
  const map: Record<SourceStatus, { label: string; tone: Tone }> = {
    healthy: { label: "Healthy", tone: "success" },
    write_access: { label: "Can change data", tone: "warning" },
    learning: { label: "Learning", tone: "accent" },
    syncing: { label: "Syncing", tone: "accent" },
    failed: { label: s.learnedAt ? "Sync failed" : "Learning failed", tone: "danger" },
    error: { label: "Can't connect", tone: "danger" },
    failing: { label: "Queries failing", tone: "danger" },
    disabled: { label: "Disabled", tone: "default" },
  };
  return map[s.status];
}

/** Statuses that need someone to act: shown in the attention banner and the sidebar pill. */
export const needsAttention = (s: Pick<SourceSummary, "status">) =>
  s.status === "failed" || s.status === "error" || s.status === "failing";

const icons: Record<Tone, React.ReactNode> = {
  success: <CircleCheck className="size-3" aria-hidden />,
  warning: <TriangleAlert className="size-3" aria-hidden />,
  danger: <CircleX className="size-3" aria-hidden />,
  accent: <Spinner size="sm" className="size-3" aria-hidden />,
  default: <CircleMinus className="size-3" aria-hidden />,
};

/** The status chip from the sources list. */
export function SourceStatusChip({ source }: { source: Pick<SourceSummary, "status" | "learnedAt"> }) {
  const { label, tone } = statusLabel(source);
  return (
    <Chip size="sm" variant="soft" color={tone} className="gap-1">
      {icons[tone]}
      {label}
    </Chip>
  );
}

/** "Sample data": the demo company, connected like any database and marked by its database comment. */
export function SampleDataChip() {
  return (
    <Chip size="sm" variant="soft" color="accent">
      Sample data
    </Chip>
  );
}

import { Chip } from "@heroui/react";

/** The six verification states. */
export type VerificationStatus = "unverified" | "in-progress" | "verified" | "stale" | "failed" | "error";

const label: Record<VerificationStatus, string> = {
  unverified: "Unverified",
  "in-progress": "In progress",
  verified: "Verified",
  stale: "Stale",
  failed: "Failed",
  error: "Error",
};

const tone: Record<VerificationStatus, string> = {
  unverified: "bg-status-unverified-soft text-status-unverified-foreground",
  "in-progress": "bg-status-progress-soft text-status-progress-foreground",
  verified: "bg-status-verified-soft text-status-verified-foreground",
  stale: "bg-status-stale-soft text-status-stale-foreground",
  failed: "bg-status-failed-soft text-status-failed-foreground",
  error: "bg-status-error-soft text-status-error-foreground",
};

/** Verification badge for answers and artifacts. Colours come only from the status tokens. */
export function StatusBadge({ status }: { status: VerificationStatus }) {
  return (
    <Chip size="sm" className={tone[status]}>
      {label[status]}
    </Chip>
  );
}

import { Chip, Spinner } from "@heroui/react";
import type { CheckStatus, DefinitionStatus } from "@opendash/core";
import { StatusBadge } from "@opendash/ui";
import { Sparkles, TriangleAlert } from "lucide-react";

/** Where a definition stands (the Knowledge list's Status): Verified, Proposed (drafted by OpenDash), Needs review, Draft. */
export function DefinitionStatusChip({ status }: { status: DefinitionStatus }) {
  if (status === "verified") return <StatusBadge status="verified" />;
  if (status === "proposed") {
    return (
      <Chip size="sm" variant="soft" color="accent" className="gap-1">
        <Sparkles className="size-3" aria-hidden />
        Proposed
      </Chip>
    );
  }
  if (status === "needs_review") {
    return (
      <Chip size="sm" variant="soft" color="warning" className="gap-1">
        <TriangleAlert className="size-3" aria-hidden />
        Needs review
      </Chip>
    );
  }
  return (
    <Chip size="sm" variant="soft">
      {status === "deprecated" ? "Deprecated" : "Draft"}
    </Chip>
  );
}

/** What its tests against the data found (the chips on what was learned): Tests passed, Needs a look, Tests failed, or still testing. */
export function ChecksChip({ checks }: { checks: CheckStatus | null }) {
  if (!checks) {
    return (
      <Chip size="sm" variant="soft" className="gap-1.5">
        <Spinner size="sm" aria-hidden />
        Testing
      </Chip>
    );
  }
  const [color, label] =
    checks === "passed"
      ? (["success", "Tests passed"] as const)
      : checks === "needs_review"
        ? (["warning", "Needs a look"] as const)
        : (["danger", "Tests failed"] as const);
  return (
    <Chip size="sm" variant="soft" color={color}>
      {label}
    </Chip>
  );
}

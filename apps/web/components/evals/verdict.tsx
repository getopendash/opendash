import { Chip } from "@heroui/react";
import type { EvalRunMetrics, EvalRunSummary } from "@opendash/core";
import { shortDateTime } from "@/lib/format";

const LABEL: Record<string, string> = { pass: "Passed", fail: "Failed", error: "Couldn't check", pending: "Waiting" };
const COLOR: Record<string, "success" | "danger" | "warning" | "default"> = {
  pass: "success",
  fail: "danger",
  error: "warning",
  pending: "default",
};

/** A case's result: Passed, Failed, Couldn't check (no reference to grade against, or the analyst stopped). */
export function VerdictChip({ verdict }: { verdict: string }) {
  return (
    <Chip size="sm" variant="soft" color={COLOR[verdict] ?? "default"} className="shrink-0">
      {LABEL[verdict] ?? verdict}
    </Chip>
  );
}

/** "14 of 15 passed" with its rate, green only when every check passed. */
export function RunScore({ metrics, chip = false }: { metrics: Partial<EvalRunMetrics>; chip?: boolean }) {
  const total = metrics.total ?? 0;
  const passed = metrics.passed ?? 0;
  const all = total > 0 && passed === total;
  const text = `${passed} of ${total} passed`;
  if (chip) {
    return (
      <Chip size="sm" variant="soft" color={all ? "success" : "warning"} className="shrink-0">
        {text}
      </Chip>
    );
  }
  return (
    <>
      <span className="tabular-nums">{text}</span>
      {total ? (
        <Chip size="sm" variant="soft" color={all ? "success" : "warning"}>
          {Math.round((passed / total) * 100)}%
        </Chip>
      ) : null}
    </>
  );
}

/** "Oct 10, 14:02 UTC · Run now by Dana Okafor · 6 min", or "Nightly". */
export function runWhen(r: EvalRunSummary & { requester?: string | null }): string {
  const who = r.trigger === "schedule" ? "Nightly" : `Run now by ${r.requester ?? "an admin"}`;
  const took =
    r.startedAt && r.finishedAt
      ? ` · ${Math.max(1, Math.round((Date.parse(r.finishedAt) - Date.parse(r.startedAt)) / 60_000))} min`
      : "";
  return `${shortDateTime(r.createdAt)} · ${who}${took}`;
}

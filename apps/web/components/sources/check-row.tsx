import { ProgressBar, Spinner } from "@heroui/react";
import type { Step } from "@opendash/connectors";
import { Circle, CircleCheck, CircleMinus, CircleX, TriangleAlert } from "lucide-react";

/** "38 of 64 columns" → [38, 64]: a running step that reports how far it has got. */
function progressOf(detail: string | undefined): [number, number] | null {
  const m = detail ? /^([\d,]+) of ([\d,]+)\b/.exec(detail) : null;
  if (!m) return null;
  const [done, total] = [Number(m[1]?.replaceAll(",", "")), Number(m[2]?.replaceAll(",", ""))];
  return total > 0 ? [done, total] : null;
}

/** A step's status icon (Check Row): pending, running, ok, warn, fail, skipped. */
export function StepIcon({ status }: { status: Step["status"] }) {
  return {
    pending: <Circle className="size-4 text-muted-tertiary" aria-hidden />,
    running: <Spinner size="sm" aria-hidden />,
    ok: <CircleCheck className="size-4 text-success" aria-hidden />,
    warn: <TriangleAlert className="size-4 text-warning" aria-hidden />,
    fail: <CircleX className="size-4 text-danger" aria-hidden />,
    skipped: <CircleMinus className="size-4 text-muted-tertiary" aria-hidden />,
  }[status];
}

/**
 * One step of a connection check or a learning run (Check Row): icon, what happened, a short
 * detail, and a progress bar while a step that counts is running.
 */
export function CheckRow({ check }: { check: Step }) {
  const icon = <StepIcon status={check.status} />;
  const muted = check.status === "pending" || check.status === "skipped";
  const progress = check.status === "running" ? progressOf(check.detail) : null;
  return (
    <li className="flex flex-col gap-1.5 py-1.75">
      <div className="flex items-start gap-2.5">
        <span className="flex h-5 shrink-0 items-center">{icon}</span>
        <span className={`flex-1 text-body ${muted ? "text-muted" : "text-foreground"}`}>
          {check.label}
          {check.status === "fail" && check.detail ? (
            <span className="mt-0.5 block text-small text-danger">{check.detail}</span>
          ) : null}
        </span>
        {check.status !== "fail" && check.detail ? (
          <span className="shrink-0 text-small leading-5 text-muted-tertiary">{check.detail}</span>
        ) : null}
      </div>
      {progress ? (
        <ProgressBar aria-label={check.label} size="sm" value={progress[0]} maxValue={progress[1]} className="ps-6.5">
          <ProgressBar.Track>
            <ProgressBar.Fill />
          </ProgressBar.Track>
        </ProgressBar>
      ) : null}
    </li>
  );
}

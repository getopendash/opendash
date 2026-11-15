"use client";

import { Disclose } from "@opendash/ui";
import {
  Brain,
  ChartGantt,
  ChevronRight,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleX,
  FileCode,
  FilePen,
  Info,
  RotateCcw,
  RotateCw,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import { useState } from "react";
import type { RunStep, StepStatus } from "@/lib/run-steps";
import { friendlyProblem } from "@/lib/step-problems";
import { CallBody } from "./call-detail";

const ICON: Record<StepStatus, React.ReactNode> = {
  // The step it's on: its label shimmers; no spinner.
  running: <CircleDashed className="size-4 text-muted-tertiary" aria-hidden />,
  ok: <CircleCheck className="size-4 text-success" aria-hidden />,
  warn: <TriangleAlert className="size-4 text-warning" aria-hidden />,
  fail: <CircleX className="size-4 text-danger" aria-hidden />,
  info: <RotateCw className="size-4 text-accent" aria-hidden />,
};

/**
 * One step. A step that failed is the analyst trying another way, so it reads as that: a quiet row with what it was
 * about, and the source's own words one press away. Red is only for the run itself, in its summary row.
 */
function StepRow({ step, runId }: { step: RunStep; runId?: string | undefined }) {
  const [open, setOpen] = useState(false);
  // One call of a finished step opens to what it did (its SQL, its edits, what came back).
  const call = runId && step.callId && step.status !== "running" ? step.callId : null;
  const thinking = step.label === "Thinking";
  const retried = step.status === "fail";
  // A file written or edited, or a check the agent is fixing: its own work going on, drawn quietly (no warning colour).
  const own =
    step.icon === "fix" ? (
      <Wrench className="size-4 text-muted" aria-hidden />
    ) : step.icon && step.status !== "running" ? (
      step.icon === "edit" ? (
        <FilePen className="size-4 text-muted" aria-hidden />
      ) : (
        <FileCode className="size-4 text-muted" aria-hidden />
      )
    ) : null;
  const icon = own ? (
    own
  ) : thinking ? (
    <Brain className="size-4 text-muted" aria-hidden />
  ) : retried ? (
    <RotateCcw className="size-4 text-muted-tertiary" aria-hidden />
  ) : (
    ICON[step.status]
  );
  // What the source said, kept for those who want it: only where it adds to the plain words.
  const why = step.status === "fail" ? step.detail?.trim() : undefined;
  const words = step.status === "fail" ? friendlyProblem(step.detail) : step.detail;
  const expands = (thinking && Boolean(step.notes)) || Boolean(why) || Boolean(call) || Boolean(step.found?.length);
  const tone = step.status === "warn" ? "text-warning-soft-foreground" : "text-muted-tertiary";
  return (
    // New rows rise in as the run reaches them (motion).
    <li className="enter-rise flex flex-col">
      <div className="flex min-h-7 items-center gap-2.5">
        <span className="flex size-4 shrink-0 items-center justify-center">{icon}</span>
        <span
          className={`min-w-0 flex-1 truncate text-body ${step.status === "running" ? "shimmer" : thinking || retried || step.icon === "fix" ? "text-muted" : "text-foreground"}`}
        >
          {step.label}
        </span>
        {expands ? (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className={`group flex max-w-1/2 shrink-0 items-center gap-1 text-small hover:text-foreground ${tone}`}
          >
            <span className="truncate">{words}</span>
            <ChevronRight className="size-3 shrink-0 transition-transform group-aria-expanded:rotate-90" aria-hidden />
          </button>
        ) : step.detail ? (
          <span className={`max-w-1/2 shrink-0 truncate text-small ${tone}`}>{words}</span>
        ) : null}
      </div>
      {step.lines?.length ? (
        // A dashboard's sections as they're written, or why its save didn't pass.
        <ul className="ms-6.5 flex flex-col gap-0.5 pb-1">
          {step.lines.map((line, i) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: the lines are a snapshot, in order
              key={i}
              className={`truncate text-small ${step.status === "warn" ? "text-warning-soft-foreground" : "text-muted"}`}
            >
              {line}
            </li>
          ))}
        </ul>
      ) : null}
      {step.found?.length ? (
        // What the check found, in its words: the agent is fixing it.
        <Disclose open={open} className="pt-1.5">
          <ul className="ms-6.5 flex flex-col gap-1 rounded-xl bg-surface-secondary px-3 py-2">
            {step.found.map((line, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a snapshot of what the check said, in order
              <li key={i} className="select-text whitespace-pre-wrap break-words text-small text-muted">
                {line}
              </li>
            ))}
          </ul>
        </Disclose>
      ) : null}
      {thinking && step.notes ? (
        // Working notes: never traced, never in the answer, exports or links. They open smoothly.
        <Disclose open={open} className="pt-1.5">
          <div className="ms-6.5 flex flex-col gap-1 rounded-xl bg-surface-secondary px-3 py-2">
            <span className="text-micro text-muted-tertiary">
              Working notes. Not checked; numbers here aren't traced.
            </span>
            <p className="whitespace-pre-wrap text-small text-muted">{step.notes}</p>
          </div>
        </Disclose>
      ) : null}
      {call && runId ? (
        // The call itself under what the source said, when it failed: the SQL that didn't run is what you want to see.
        <Disclose open={open} className="pt-1.5">
          <div className={`ms-6.5 ${why ? "order-last" : ""}`}>
            {open ? <CallBody runId={runId} callId={call} /> : null}
          </div>
        </Disclose>
      ) : null}
      {why ? (
        <Disclose open={open} className="pt-1.5">
          <div className="ms-6.5 flex flex-col gap-1 rounded-xl bg-surface-secondary px-3 py-2">
            <span className="text-micro text-muted-tertiary">
              What the source said. The analyst has gone on from it.
            </span>
            <p className="select-text whitespace-pre-wrap break-words text-small text-muted">{why}</p>
          </div>
        </Disclose>
      ) : null}
    </li>
  );
}

/**
 * A run's summary row and, under it, its steps: open while the run works, collapsed once it's done, unless
 * someone opened or closed them by hand. `pair` starts the summary row (Pair); `aside` ends it (the path
 * label, Unverified).
 */
export function RunStepsView({
  summary,
  steps,
  status,
  aside,
  pair,
  onTrace,
  runId,
}: {
  summary: string;
  steps: RunStep[];
  status: "active" | "done" | "stopped" | "failed";
  aside?: React.ReactNode;
  pair?: React.ReactNode;
  /** Opens the run's full trace: its timeline, under its steps. */
  onTrace?: () => void;
  /** The run, so a step that is one call opens to what it did. */
  runId?: string;
}) {
  const [chosen, setChosen] = useState<boolean | null>(null);
  const open = chosen ?? status === "active";
  const setOpen = (fn: (v: boolean) => boolean) => setChosen(fn(open));
  const icon =
    status === "active" ? (
      <CircleDot className="size-4 text-accent" aria-hidden />
    ) : status === "done" ? (
      <CircleCheck className="size-4 text-success" aria-hidden />
    ) : status === "stopped" ? (
      <Info className="size-4 text-muted" aria-hidden />
    ) : (
      <CircleX className="size-4 text-danger" aria-hidden />
    );
  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center gap-2">
        {/* Pair and the pill stay on one line: in a narrow column the pill's words wrap beside Pair. */}
        <div className="flex min-w-0 items-center gap-2">
          {pair}
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="group flex w-fit min-w-0 items-center gap-2 rounded-xl bg-surface-secondary px-2.5 py-1.5 text-left text-body text-muted hover:text-foreground"
          >
            {icon}
            <span className="tabular-nums">{summary}</span>
            {steps.length ? (
              <ChevronRight
                className="size-3.5 shrink-0 transition-transform group-aria-expanded:rotate-90"
                aria-hidden
              />
            ) : null}
          </button>
        </div>
        {aside}
      </div>
      {/* The steps fold away smoothly once the answer is in, and open again on a press. */}
      {steps.length || status === "active" ? (
        <Disclose open={open} className="pt-2">
          <ul aria-live="polite" className="flex flex-col gap-0.5 ps-1">
            {steps.map((step) => (
              <StepRow key={step.key} step={step} runId={runId} />
            ))}
            {/* Between model calls nothing is running: the analyst is thinking about what to do next. */}
            {status === "active" && !steps.some((x) => x.status === "running") ? (
              <StepRow step={{ key: "ghost", status: "running", label: "Thinking" }} />
            ) : null}
            {onTrace ? (
              <li className="pt-1">
                <button
                  type="button"
                  onClick={onTrace}
                  className="flex items-center gap-1.5 text-small text-muted hover:text-foreground"
                >
                  <ChartGantt className="size-3.5" aria-hidden />
                  The full trace: each call's time, tokens and cost
                </button>
              </li>
            ) : null}
          </ul>
        </Disclose>
      ) : null}
    </div>
  );
}

"use client";

import type { Step } from "@opendash/connectors";
import type { ConnectionTestView, SourceSummary } from "@opendash/core";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ago, dataTime } from "@/lib/format";
import { CheckRow } from "./check-row";

const POLL_MS = 500;
const FINISHED = new Set(["passed", "warning", "blocked", "failed"]);

/**
 * Health: the latest connection check, step by step (followed live while a re-check runs), then the last
 * learning run and how recent the data is. When a re-check ends the page refreshes, so the status everywhere
 * reflects it.
 */
export function HealthPanel({
  initial,
  source,
  now,
}: {
  initial: ConnectionTestView | null;
  source: Pick<SourceSummary, "syncStatus" | "learnedAt" | "statusDetail" | "dataTo" | "status">;
  now: number;
}) {
  const router = useRouter();
  const [test, setTest] = useState(initial);
  const testId = initial?.id;
  const settled = !initial || FINISHED.has(initial.status);

  useEffect(() => {
    if (!testId || settled) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const response = await fetch(`/api/connection-tests/${testId}`, { cache: "no-store" });
        if (response.ok) {
          const next = (await response.json()) as ConnectionTestView;
          if (stopped) return;
          setTest(next);
          if (FINISHED.has(next.status)) {
            router.refresh();
            return;
          }
        }
      } catch {
        // A dropped request is retried on the next tick.
      }
      if (!stopped) timer = setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [testId, settled, router]);

  const running = test !== null && !FINISHED.has(test.status);
  const sync: Step | null =
    source.syncStatus === "queued" || source.syncStatus === "running"
      ? { key: "sync", status: "running", label: "Syncing now" }
      : source.syncStatus === "failed"
        ? {
            key: "sync",
            status: "fail",
            label: "Last sync failed",
            detail: source.statusDetail ?? "OpenDash couldn't finish.",
          }
        : source.learnedAt
          ? { key: "sync", status: "ok", label: "Last sync succeeded", detail: ago(source.learnedAt, now) }
          : null;
  // The check can pass while queries fail later (a password changed since): the latest query says so here too.
  const queries: Step | null =
    source.status === "failing"
      ? {
          key: "queries",
          status: "fail",
          label: "Latest query couldn't connect",
          detail: source.statusDetail ?? "It was refused before it ran.",
        }
      : null;
  const data: Step | null = source.dataTo
    ? { key: "data", status: "ok", label: "Latest data", detail: dataTime(source.dataTo, now) }
    : null;

  return (
    <section aria-labelledby="health-title" className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-4">
        <h2 id="health-title" className="text-body font-medium">
          Health
        </h2>
        <span className="text-small text-muted-tertiary">
          {running
            ? "Checking now…"
            : test?.finishedAt
              ? `Last checked ${ago(test.finishedAt, now)}`
              : "Not checked yet"}
        </span>
      </div>
      {/* Why it failed, when no step says so (a step that failed carries its own reason). */}
      {test && !running && test.message && !test.checks.some((c) => c.status === "fail") ? (
        <p className="text-small text-danger">{test.message}</p>
      ) : null}
      <ul className="flex flex-col">
        {test?.checks.map((check) => (
          <CheckRow key={check.key} check={check} />
        ))}
        {queries ? <CheckRow check={queries} /> : null}
        {sync ? <CheckRow check={sync} /> : null}
        {data ? <CheckRow check={data} /> : null}
      </ul>
    </section>
  );
}

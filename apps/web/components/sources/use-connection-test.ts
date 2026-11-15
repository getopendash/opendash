"use client";

import type { ConnectionTestView } from "@opendash/core";
import { useEffect, useState } from "react";

const POLL_MS = 500;
export const FINISHED_TESTS = new Set(["passed", "warning", "blocked", "failed"]);

/**
 * Follows a connection check while the worker runs it: polls it until it settles, and says when no
 * worker has picked it up for too long. A new test id restarts it; unmounting stops it.
 */
export function useConnectionTest(testId: string | null, queuedWarningMs: number) {
  const [test, setTest] = useState<ConnectionTestView | null>(null);
  const [slowWorker, setSlowWorker] = useState(false);

  useEffect(() => {
    setTest(null);
    setSlowWorker(false);
    if (!testId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const started = Date.now();
    const tick = async () => {
      try {
        const response = await fetch(`/api/connection-tests/${testId}`, { cache: "no-store" });
        if (response.ok) {
          const next = (await response.json()) as ConnectionTestView;
          if (stopped) return;
          setTest(next);
          setSlowWorker(next.status === "queued" && Date.now() - started > queuedWarningMs);
          if (FINISHED_TESTS.has(next.status)) return;
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
  }, [testId, queuedWarningMs]);

  return { test, slowWorker, running: testId !== null && (test === null || !FINISHED_TESTS.has(test.status)) };
}

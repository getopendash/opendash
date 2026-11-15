"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { apiQueries } from "@/lib/api";

interface StreamedEvent {
  seq: number;
  attempt: number;
  type: string;
  data: unknown;
  createdAt: string;
}
interface EventsData {
  events: StreamedEvent[];
  run: { status: string } & Record<string, unknown>;
}

/**
 * Keeps a run's events (the runs.events query) current from its server-sent events while it's active (
 * Streaming), instead of polling. Opens once the first read has landed, from the last event it holds, so nothing is
 * missed; when the run ends it reads once more for the outcome. Returns whether the stream is up: while it isn't, the
 * caller polls.
 */
export function useRunStream(runId: string, enabled: boolean): boolean {
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => apiQueries.runs.events.queryKey({ input: { runId, afterSeq: 0 } }), [runId]);
  const [live, setLive] = useState(false);

  useEffect(() => {
    if (!enabled || typeof EventSource === "undefined") return;
    const held = queryClient.getQueryData<EventsData>(queryKey);
    const after = (held?.events ?? []).reduce((m, e) => Math.max(m, e.seq), 0);
    const source = new EventSource(`/api/runs/${runId}/events${after ? `?after=${after}` : ""}`);
    let failures = 0;
    const update = (fn: (old: EventsData) => EventsData) =>
      queryClient.setQueryData<EventsData>(queryKey, (old) => (old ? fn(old) : old));
    source.onopen = () => {
      failures = 0;
      setLive(true);
    };
    source.addEventListener("run_event", (m) => {
      const e = JSON.parse((m as MessageEvent<string>).data) as StreamedEvent;
      update((old) =>
        old.events.some((x) => x.seq === e.seq)
          ? old
          : { ...old, events: [...old.events, e].sort((a, b) => a.seq - b.seq) },
      );
    });
    source.addEventListener("status", (m) => {
      const { status } = JSON.parse((m as MessageEvent<string>).data) as { status: string };
      update((old) => ({ ...old, run: { ...old.run, status } }));
    });
    source.addEventListener("end", () => {
      source.close();
      setLive(false);
      void queryClient.invalidateQueries({ queryKey });
    });
    // The browser reconnects by itself (with Last-Event-ID); after repeated failures, polling takes over.
    source.onerror = () => {
      failures += 1;
      if (source.readyState === EventSource.CLOSED || failures >= 3) {
        source.close();
        setLive(false);
      }
    };
    return () => {
      source.close();
      setLive(false);
    };
  }, [runId, enabled, queryClient, queryKey]);

  return live;
}

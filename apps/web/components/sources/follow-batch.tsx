"use client";

import { Button } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { ChartGantt } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { useRunStream } from "@/components/ask/use-run-stream";
import { usePanel } from "@/components/panel/panel-context";
import { apiQueries } from "@/lib/api";
import { RefreshWhile } from "./refresh-while";

const FOLLOWED = new Set(["child_started", "child_ended", "run_end"]);

/**
 * A drafting batch's card follows its lead: each drafter's start and end, as the lead writes them, reads
 * the page again at once. The lead's events stream; while the stream is down they're read every 5 s. A slower read
 * (30 s) keeps the card's times moving between events. Someone who can't read the lead's events (neither its asker
 * nor an owner or admin) gets the page read every 10 s, as before.
 */
export function FollowBatch({ runId }: { runId: string }) {
  const router = useRouter();
  const streaming = useRef(false);
  const events = useQuery({
    ...apiQueries.runs.events.queryOptions({ input: { runId, afterSeq: 0 } }),
    retry: false,
    refetchInterval: () => (streaming.current ? false : 5_000),
  });
  const working = ["queued", "running", "cancelling"].includes(events.data?.run.status ?? "running");
  streaming.current = useRunStream(runId, working && events.data !== undefined);
  const said = (events.data?.events ?? []).filter((e) => FOLLOWED.has(e.type)).length;
  // What the page was drawn with: only something the lead says after that reads it again.
  const seen = useRef<number | null>(null);
  useEffect(() => {
    if (!events.data) return;
    if (seen.current !== null && said > seen.current) router.refresh();
    seen.current = said;
  }, [said, events.data, router]);
  if (events.error) return <RefreshWhile everyMs={10_000} />;
  return <RefreshWhile everyMs={30_000} />;
}

/** The batch's trace, in the panel: its drafters side by side, their time and cost. */
export function BatchTraceButton({ runId }: { runId: string }) {
  const panel = usePanel();
  return (
    <Button size="sm" variant="ghost" onPress={() => panel.show({ view: "trace", runId })}>
      <ChartGantt className="size-3.5" aria-hidden />
      Trace
    </Button>
  );
}

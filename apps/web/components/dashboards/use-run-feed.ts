"use client";

import { useCallback, useSyncExternalStore } from "react";
import { api } from "@/lib/api";
import { createRunFeeds, RUN_FEED_START, type RunFeedState } from "@/lib/run-feed";

/** The page's one reader of each run's events (lib/run-feed.ts says why). */
const feeds = createRunFeeds((runId, afterSeq) => api.runs.events({ runId, afterSeq }));

/** A run's events and status as the page reads them: one read however many pieces follow the same run. */
export function useRunFeed(runId: string): RunFeedState {
  const subscribe = useCallback((fn: () => void) => feeds.subscribe(runId, fn), [runId]);
  return useSyncExternalStore(
    subscribe,
    () => feeds.get(runId),
    () => RUN_FEED_START,
  );
}

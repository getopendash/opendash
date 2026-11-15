import type { RunEventLike } from "./run-steps";

/** What a page knows of a run it follows: its events so far, its status, and whether it could be read. */
export interface RunFeedState {
  events: readonly RunEventLike[];
  status: string;
  /** Heard from once. */
  loaded: boolean;
  /** Not this person's to read (not theirs, gone): nothing to follow, never followed for ever. */
  unreadable: boolean;
  /** The last read failed for another reason: tried again in a moment. */
  failing: boolean;
}

/** Before the first answer: still running, as far as anyone knows. */
export const RUN_FEED_START: RunFeedState = {
  events: [],
  status: "running",
  loaded: false,
  unreadable: false,
  failing: false,
};

/** A run still going: its events keep coming. */
const ACTIVE = new Set(["queued", "running", "cancelling"]);

type Fetch = (runId: string, afterSeq: number) => Promise<{ events: RunEventLike[]; run: { status: string } }>;
interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

/**
 * One read of each run's events for the whole page, however many pieces follow it (the build bar, the App's glowing
 * edge): each used to read the same run every second and keep its own copy of every event.
 * Read every second while the run goes on, every three after a failed read; never again once it ends or can't be read.
 * When the last piece following a run goes, its reading stops and what it heard is dropped.
 */
export function createRunFeeds(
  fetch: Fetch,
  timers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as number) },
) {
  interface Feed {
    state: RunFeedState;
    listeners: Set<() => void>;
    seq: number;
    timer: unknown;
  }
  const feeds = new Map<string, Feed>();

  const set = (runId: string, feed: Feed, next: Partial<RunFeedState>) => {
    feed.state = { ...feed.state, ...next };
    if (feeds.get(runId) !== feed) return;
    for (const fn of feed.listeners) fn();
  };
  const poll = async (runId: string, feed: Feed) => {
    feed.timer = undefined;
    try {
      const r = await fetch(runId, feed.seq);
      if (feeds.get(runId) !== feed) return;
      // Only events after the last one heard: two reads that overlap never add one twice.
      const fresh = r.events.filter((e) => e.seq > feed.seq);
      if (fresh.length) feed.seq = Math.max(feed.seq, ...fresh.map((e) => e.seq));
      set(runId, feed, {
        ...(fresh.length ? { events: [...feed.state.events, ...fresh] } : {}),
        status: r.run.status,
        loaded: true,
        failing: false,
      });
      if (ACTIVE.has(r.run.status)) feed.timer = timers.set(() => void poll(runId, feed), 1000);
    } catch (error) {
      if (feeds.get(runId) !== feed) return;
      const code = (error as { code?: unknown } | null)?.code;
      if (code === "NOT_FOUND" || code === "FORBIDDEN") {
        set(runId, feed, { loaded: true, status: "failed", unreadable: true, failing: false });
        return;
      }
      set(runId, feed, { failing: true });
      feed.timer = timers.set(() => void poll(runId, feed), 3000);
    }
  };

  return {
    /** Follows a run: told whenever what's known of it changes. Returns how to stop. */
    subscribe(runId: string, fn: () => void): () => void {
      let feed = feeds.get(runId);
      if (!feed) {
        feed = { state: RUN_FEED_START, listeners: new Set(), seq: 0, timer: undefined };
        feeds.set(runId, feed);
        void poll(runId, feed);
      }
      const mine = feed;
      mine.listeners.add(fn);
      return () => {
        mine.listeners.delete(fn);
        if (mine.listeners.size || feeds.get(runId) !== mine) return;
        if (mine.timer !== undefined) timers.clear(mine.timer);
        feeds.delete(runId);
      };
    },
    /** What's known of a run now: the same object until something changes. */
    get(runId: string): RunFeedState {
      return feeds.get(runId)?.state ?? RUN_FEED_START;
    },
  };
}

// How many new warehouse queries one person may start from dashboards. A person exploring (opening a dashboard, changing
// a filter, searching a column's values) never meets it; a script choosing values in a loop, or re-running a failing
// query, does. Kept per process, so a deployment with several web servers allows that many times this. The warehouse
// itself is also protected by the gateway's per-source limit on queries at once.

/** New choices: a dashboard opened, a filter changed, a column searched. A choice's tiles run as one decision. */
export const DASHBOARD_MISS_BURST = 48;
const CHOICES_PER_SECOND = 0.5;
/** Queries started, whatever the choice: a choice reruns at most a dashboard's 16 queries, so this is 12 choices' worth. */
export const DASHBOARD_QUERY_BURST = 192;
const QUERIES_PER_SECOND = 2;
/** A choice charged this long ago still covers its other tiles; a query queued this long ago is still waited for. */
const RECENT_MS = 30_000;

interface Bucket {
  tokens: number;
  at: number;
}

export interface DashboardAsk {
  /** The viewer: org and user (or API key). */
  who: string;
  /** The viewer's choice on one dashboard: its id, the filters as chosen, a column search. */
  choice: string;
  /** The query's cache key. */
  cacheKey: string;
  /** Retry: asks for a new run of a query whose last one failed, so it's always charged. */
  retry?: boolean;
}

/**
 * The limit, with its clock injected so it's tested as it runs. `admit` says whether a dashboard query may be queued
 * now: "waiting" when it was queued in the last 30 s (a page asking again about a tile still running, which spends
 * nothing), "queue" when it may be (and it's charged), "busy" when the viewer has started too much.
 */
export function createDashboardLimiter() {
  const choices = new Map<string, Bucket>();
  const queries = new Map<string, Bucket>();
  const queued = new Map<string, number>();
  const charged = new Map<string, number>();

  const take = (map: Map<string, Bucket>, key: string, burst: number, perSecond: number, now: number, dry: boolean) => {
    const b = map.get(key) ?? { tokens: burst, at: now };
    const tokens = Math.min(burst, b.tokens + ((now - b.at) / 1000) * perSecond);
    if (tokens < 1) return false;
    if (!dry) {
      if (map.size > 10_000) map.clear();
      map.set(key, { tokens: tokens - 1, at: now });
    }
    return true;
  };
  const fresh = (map: Map<string, number>, key: string, now: number) => {
    const at = map.get(key);
    if (at === undefined) return false;
    if (now - at < RECENT_MS) return true;
    map.delete(key);
    return false;
  };

  return {
    admit(ask: DashboardAsk, now = Date.now()): "waiting" | "queue" | "busy" {
      if (!ask.retry && fresh(queued, ask.cacheKey, now)) return "waiting";
      // A choice is charged once, and covers its other tiles for 30 s after that charge (never refreshed by them), so
      // repeating one choice pays again; a Retry is always a new decision.
      const covered = !ask.retry && fresh(charged, ask.choice, now);
      const choiceOk = covered || take(choices, ask.who, DASHBOARD_MISS_BURST, CHOICES_PER_SECOND, now, true);
      const queryOk = take(queries, ask.who, DASHBOARD_QUERY_BURST, QUERIES_PER_SECOND, now, true);
      if (!choiceOk || !queryOk) return "busy";
      if (!covered) {
        take(choices, ask.who, DASHBOARD_MISS_BURST, CHOICES_PER_SECOND, now, false);
        if (charged.size > 10_000) charged.clear();
        charged.set(ask.choice, now);
      }
      take(queries, ask.who, DASHBOARD_QUERY_BURST, QUERIES_PER_SECOND, now, false);
      if (queued.size > 10_000) queued.clear();
      queued.set(ask.cacheKey, now);
      return "queue";
    },
  };
}

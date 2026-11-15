import type { ThreadFilters, ThreadState } from "@opendash/core";
import { THREAD_STATE_LABELS } from "./thread-status";

/** The conversations list lives in the URL (/ask?q=…&scope=…&project=…&status=…&page=…), so a filtered list can be shared. */
export const PAGE_SIZE = 50;

export type Scope = "all" | "mine" | "shared" | "starred";

export interface HistoryParams {
  scope: Scope;
  q: string;
  project: string | null;
  state: ThreadState | null;
  page: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The list's settings from the URL; anything unknown falls back to the default rather than failing. */
export function parseHistory(sp: Record<string, string | string[] | undefined>): HistoryParams {
  const one = (k: string) => {
    const v = sp[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const scope = one("scope");
  const state = one("status");
  const project = one("project");
  const page = Number(one("page"));
  return {
    scope: scope === "mine" || scope === "shared" || scope === "starred" ? scope : "all",
    q: (one("q") ?? "").slice(0, 200),
    project: project && UUID.test(project) ? project.toLowerCase() : null,
    state: state && Object.hasOwn(THREAD_STATE_LABELS, state) ? (state as ThreadState) : null,
    page: Number.isInteger(page) && page > 1 ? Math.min(page, 2000) : 1,
  };
}

/** The URL for these settings with a change; any change but the page goes back to the first page. */
export function historyHref(p: HistoryParams, change: Partial<HistoryParams> = {}): string {
  const next = { ...p, page: 1, ...change };
  const sp = new URLSearchParams();
  if (next.q.trim()) sp.set("q", next.q.trim());
  if (next.scope !== "all") sp.set("scope", next.scope);
  if (next.project) sp.set("project", next.project);
  if (next.state) sp.set("status", next.state);
  if (next.page > 1) sp.set("page", String(next.page));
  const query = sp.toString();
  return query ? `/ask?${query}` : "/ask";
}

/** What core filters on. */
export const filtersOf = (p: HistoryParams): ThreadFilters => ({
  scope: p.scope,
  ...(p.q.trim() ? { q: p.q } : {}),
  ...(p.project ? { projectId: p.project } : {}),
  ...(p.state ? { state: p.state } : {}),
});

/** A search or a filter narrows the list (the scope is a view, not a filter). */
export const isNarrowed = (p: HistoryParams) => Boolean(p.q.trim() || p.project || p.state);

const DAY = 86_400_000;

/** The conversations list's groups: when a conversation last moved, by day in UTC like every date the app shows. */
export function whenGroup(at: string, now: number): string {
  const days = Math.floor(now / DAY) - Math.floor(Date.parse(at) / DAY);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "Previous 7 days";
  if (days < 30) return "Previous 30 days";
  return "Earlier";
}

/** The pages around this one: the first, the last, and its neighbours, with gaps between. */
export function pagesAround(page: number, last: number): (number | "gap")[] {
  const shown = [...new Set([1, page - 1, page, page + 1, last])]
    .filter((p) => p >= 1 && p <= last)
    .sort((a, b) => a - b);
  return shown.flatMap((p, i) => (i && p - (shown[i - 1] as number) > 1 ? ["gap" as const, p] : [p]));
}

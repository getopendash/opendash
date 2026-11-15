import { BadgeCheck, CircleAlert, TrendingDown, TrendingUp } from "lucide-react";
import type { ReactNode } from "react";
import { Sparkline } from "./sparkline";
import { TracedNumber } from "./traced-number";

export interface TileChange {
  /** The change already formatted, without a sign: 4.2%. */
  display: string;
  up: boolean;
  /** Whether it went the metric's good way; null for a neutral metric. */
  good: boolean | null;
  /** What it's compared with: "vs Aug". */
  vs: string;
}

/**
 * A verified metric's tile (Home's key metrics, a dashboard's KpiTile): its latest value, the change from the period
 * before, a year of bars, and a footnote saying where it's from. Every figure is computed by the caller from a query;
 * the tile only draws. With `onValue` the value is a traced number that opens its query (dashboards); without, the
 * caller can make the whole tile a link (Home). A query tile passes its own `badge` (Unmodelled) in place of
 * the verified check.
 */
export function MetricTile({
  title,
  value,
  change = null,
  trend = [],
  footnote,
  action,
  onValue,
  state = "ready",
  error,
  badge,
}: {
  title: string;
  value?: string;
  change?: TileChange | null;
  trend?: (number | null)[];
  footnote?: ReactNode;
  /** A menu or button shown in the header (a dashboard's "Remove"). */
  action?: ReactNode;
  onValue?: () => void;
  state?: "ready" | "loading" | "error";
  /** For the error state: why, and what to do (a Retry button). */
  error?: ReactNode;
  /** In place of the verified check: how it was computed, for a tile that isn't a verified metric's. */
  badge?: ReactNode;
}) {
  return (
    // A container, so a narrow tile (four in a row, a trace open beside it) drops its sparkline instead of overlapping.
    <div className="metric-tile @container flex h-full min-w-0 flex-col gap-3 overflow-hidden rounded-2xl border border-border p-4">
      <span className="flex min-h-6 items-center justify-between gap-2 text-body text-muted">
        <span className="min-w-0 truncate" title={title}>
          {title}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {badge}
          {action}
          {state === "error" ? (
            <CircleAlert className="size-4 text-warning" aria-label="Couldn't run" />
          ) : badge ? null : (
            <BadgeCheck className="size-4 text-success" aria-label="Verified" />
          )}
        </span>
      </span>
      {state === "loading" ? (
        <span className="flex flex-1 flex-col justify-end gap-2" aria-busy>
          <span className="metric-tile__placeholder metric-tile__placeholder--value" />
          <span className="metric-tile__placeholder metric-tile__placeholder--line" />
        </span>
      ) : state === "error" ? (
        <span className="flex flex-1 flex-col justify-end gap-1 text-small text-muted">{error}</span>
      ) : (
        <span className="flex min-w-0 items-end justify-between gap-3">
          <span className="flex min-w-0 flex-col gap-1">
            <span className="block truncate text-number-lg tabular-nums" title={value ?? undefined}>
              {value && onValue ? <TracedNumber display={value} onPress={onValue} /> : (value ?? "—")}
            </span>
            {change ? (
              <span
                className={`flex flex-wrap items-center gap-1 text-small ${change.good === null ? "text-muted" : change.good ? "text-success" : "text-danger"}`}
              >
                {change.up ? (
                  <TrendingUp className="size-3.5" aria-hidden />
                ) : (
                  <TrendingDown className="size-3.5" aria-hidden />
                )}
                {change.display}
                <span className="text-muted">{change.vs}</span>
              </span>
            ) : null}
          </span>
          {trend.length ? <Sparkline values={trend} className="hidden h-9 w-24 shrink-0 @[15rem]:block" /> : null}
        </span>
      )}
      {footnote ? <span className="text-micro text-muted-tertiary">{footnote}</span> : null}
    </div>
  );
}

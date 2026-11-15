import { type KeyMetric, metricFigures } from "@opendash/core";
import { MetricTile } from "@opendash/ui";
import Link from "next/link";
import { ago } from "@/lib/format";

const month = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" });

/** The figures a tile draws, from the months its test read: the same function a dashboard's tile uses. */
export const figuresOf = (m: KeyMetric) => metricFigures(m, m.trend);

/** Home's key metric tile: the verified metric's latest month, its change, a year of months, and where it's from. */
function Tile({ m, now }: { m: KeyMetric; now: number }) {
  const { latest, previous, change, points } = figuresOf(m);
  return (
    <Link href={`/knowledge/metrics/${m.id}`} className="metric-tile-link rounded-2xl">
      <MetricTile
        title={m.title}
        {...(latest ? { value: latest.display } : {})}
        change={
          change && previous
            ? {
                display: change.display,
                up: change.pct >= 0,
                good: change.good,
                vs: `vs ${previous.label.split(" ")[0]}`,
              }
            : null
        }
        trend={points.map((p) => p.value)}
        footnote={`${latest ? `${month.format(new Date(`${latest.period}T00:00:00Z`))} · ` : ""}${m.connectionName} · tested ${ago(m.checkedAt, now)}`}
      />
    </Link>
  );
}

export function KeyMetrics({ metrics, now }: { metrics: KeyMetric[]; now: number }) {
  return (
    <div className="grid grid-cols-1 gap-3 @xl/page:grid-cols-2 @5xl/page:grid-cols-4">
      {metrics.map((m) => (
        <Tile key={m.id} m={m} now={now} />
      ))}
    </div>
  );
}

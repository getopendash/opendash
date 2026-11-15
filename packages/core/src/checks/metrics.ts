/**
 * Which metrics can be watched, and by which period: a verified metric with time is checked by week where
 * its time column can be read by week (or finer), by month where it's a month-end snapshot. Trend shifts and goal risk
 * read months, so a metric checked by week has a monthly check too when a routine asks for them. What a definition
 * says decides it, never a stored check result.
 */
import type { TimeGrain } from "@opendash/connectors";
import { isUuid, sql, type TenantTx } from "@opendash/db";
import type { MetricDirection, MetricFormat } from "../figures/metric";
import type { CheckGrain } from "../routines/schedule";
import type { Condition } from "../routines/spec";
import { loadSemanticModel, ModelBroken } from "../semantic/definitions";
import { metricFinestGrain, metricTimeColumn } from "../semantic/model";

export interface WatchableMetric {
  id: string;
  slug: string;
  title: string;
  connectionId: string;
  connectionName: string;
  format: MetricFormat;
  direction: MetricDirection;
  /** The period it's checked by; null for a metric without time, or read only by quarter or year. */
  grain: CheckGrain | null;
}

/** The period a metric is checked by, from the finest grain its time column can be read at (null: any). */
export function checkGrainOf(finest: TimeGrain | null): CheckGrain | null {
  if (finest === null || finest === "day" || finest === "week") return "week";
  return finest === "month" ? "month" : null;
}

/** The checks a routine's condition needs on a metric checked by `grain`. */
export function grainsFor(condition: Condition, grain: CheckGrain): CheckGrain[] {
  if (condition.kind === "goal_risk") return ["month"];
  // Unusual includes trend shifts, which read months.
  if (condition.kind === "unusual") return grain === "week" ? ["week", "month"] : ["month"];
  return [grain];
}

/** The organization's verified metrics (or these of them), by name, each with the period it's checked by. */
export async function watchableMetrics(tx: TenantTx, orgId: string, ids?: string[]): Promise<WatchableMetric[]> {
  const wanted = ids?.filter(isUuid);
  if (wanted && !wanted.length) return [];
  const rows = await tx.execute<{
    id: string;
    slug: string;
    title: string;
    connection_id: string;
    connection_name: string;
  }>(sql`
    select i.id, i.slug, i.title, i.connection_id, c.name as connection_name from app.context_item i
    join app.connection c on c.org_id = i.org_id and c.id = i.connection_id and c.deleted_at is null
    where i.org_id = ${orgId} and i.kind = 'metric' and i.deleted_at is null and i.released_version is not null
      ${wanted ? sql`and i.id = any(${`{${wanted.join(",")}}`}::uuid[])` : sql``}
    order by lower(i.title), i.id`);
  const models = new Map<string, Awaited<ReturnType<typeof loadSemanticModel>>>();
  for (const connectionId of new Set(rows.map((r) => r.connection_id))) {
    // A source whose definitions don't hold together has nothing to watch until they do.
    const loaded = await loadSemanticModel(tx, orgId, connectionId).catch((error: unknown) => {
      if (error instanceof ModelBroken) return null;
      throw error;
    });
    models.set(connectionId, loaded);
  }
  return rows.map((r) => {
    const model = models.get(r.connection_id)?.model;
    const metric = model?.metrics.get(r.slug);
    const dataset = metric ? model?.datasets.get(metric.dataset) : undefined;
    return {
      id: r.id,
      slug: r.slug,
      title: r.title,
      connectionId: r.connection_id,
      connectionName: r.connection_name,
      format: (metric?.format ??
        dataset?.measures.find((m) => m.name === metric?.measure)?.format ??
        "number") as MetricFormat,
      direction: (metric?.direction ?? "neutral") as MetricDirection,
      grain:
        metric && dataset && metricTimeColumn(metric, dataset) !== null
          ? checkGrainOf(metricFinestGrain(metric, dataset))
          : null,
    };
  });
}

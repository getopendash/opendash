/**
 * The metric path through the gateway: compile a metric query against the source's verified
 * definitions, then run the SQL through the same pipeline as any other query (validation, read-only session,
 * limits, sanity checks), recorded as path = metric with the spec and the definitions' versions.
 */
import { type DialectId, dialectFor } from "@opendash/connectors";
import { sql } from "@opendash/db";
import { type GatewayDeps, type QueryOutcome, type QueryRequest, recordUnrun, runQuery } from "../gateway/gateway";
import { type CompiledColumn, compileMetricQuery, SemanticError } from "./compile";
import { type LoadedModel, loadSemanticModel } from "./definitions";
import type { MetricQueryInput } from "./spec";

export interface MetricQueryRequest extends Omit<QueryRequest, "sql" | "params" | "semantic"> {
  query: MetricQueryInput;
  /** What "last month" means; the current time unless a test or an eval pins it. */
  now?: Date;
}

export interface MetricQueryOutcome extends QueryOutcome {
  /** Each output's role (time, dimension, measure), when it compiled. */
  roles?: CompiledColumn[];
}

/** Runs a metric query. Never throws for anything about the query: a definition it can't use is a failed outcome. */
export async function runMetricQuery(deps: GatewayDeps, req: MetricQueryRequest): Promise<MetricQueryOutcome> {
  const { loaded, dialect } = await deps.withTenant(req.orgId, async (tx) => {
    const [c] = await tx.execute<{ dialect: DialectId }>(sql`
      select dialect from app.connection where org_id = ${req.orgId} and id = ${req.connectionId}`);
    return { loaded: await loadSemanticModel(tx, req.orgId, req.connectionId), dialect: c?.dialect };
  });
  const base: QueryRequest = { ...req, sql: "", semantic: { query: req.query, definitions: [] } };
  if (!loaded || !dialect) {
    return recordUnrun(deps, base, {
      kind: "semantic",
      message: "This source has no verified metrics yet. Write SQL over its tables instead.",
    });
  }
  let compiled: ReturnType<typeof compileMetricQuery>;
  try {
    compiled = compileMetricQuery(loaded.model, req.query, {
      now: req.now ?? new Date(),
      sql: dialectFor(dialect).sql,
    });
  } catch (error) {
    if (!(error instanceof SemanticError)) throw error;
    return recordUnrun(deps, base, { kind: "semantic", message: error.message });
  }
  const outcome = await runQuery(deps, {
    ...req,
    sql: compiled.sql,
    params: compiled.params,
    semantic: { query: req.query, definitions: used(loaded, compiled.datasets, req.query.metrics) },
  });
  return outcome.status === "succeeded" ? { ...outcome, roles: compiled.columns } : outcome;
}

function used(loaded: LoadedModel, datasets: string[], metrics: string[]) {
  return [
    ...metrics.map((m) => loaded.definitions.get(`metric:${m}`)),
    ...datasets.map((d) => loaded.definitions.get(`dataset:${d}`)),
  ].filter((d) => d !== undefined);
}

// A source's values, read live when a question needs one: OpenDash keeps no copy of them. Each read is a
// bounded query OpenDash writes (`columnValuesSql`), run through the gateway as the run's own query, so it's in the
// run's steps and budgets and the gateway's personal-data rules apply to it like to any other.
import type { DialectId } from "@opendash/connectors";
import { COLUMN_SEARCH_CHARS, columnValuesSql } from "./column-values";
import { type GatewayDeps, type QueryRequest, runQuery } from "./gateway";

/** How far a live lookup reads. */
export const LIVE_VALUES = {
  /** value_lookup: candidate columns, and values each. */
  columns: 5,
  values: 10,
  /** A table's file (the agent's read): category columns read, and values each. */
  describeColumns: 8,
  describeValues: 8,
} as const;

export interface LiveRead {
  orgId: string;
  connectionId: string;
  dialect: DialectId;
  requester: QueryRequest["requester"];
  toolCallId?: string | null;
  signal?: AbortSignal;
}

export type ColumnValues =
  | {
      column: string;
      /** contains: values that contain the term; common: none did, so its most common values. */
      match: "contains" | "common";
      values: { value: string; rows: number }[];
      /** It has more values like these than are listed. */
      more: boolean;
      queryRunId: string | null;
    }
  | { column: string; problem: string; queryRunId: string | null };

type Read =
  | { ok: true; values: { value: string; rows: number }[]; more: boolean; queryRunId: string }
  | {
      ok: false;
      problem: string;
      queryRunId: string | null;
    };

async function readValues(
  deps: GatewayDeps,
  input: LiveRead,
  column: string,
  search: string | undefined,
  limit: number,
  title: string,
): Promise<Read> {
  let query: ReturnType<typeof columnValuesSql>;
  try {
    query = columnValuesSql(input.dialect, column, search, limit + 1);
  } catch {
    return { ok: false, problem: `${column} isn't a column name values can be read from.`, queryRunId: null };
  }
  const r = await runQuery(deps, {
    orgId: input.orgId,
    connectionId: input.connectionId,
    sql: query.sql,
    ...(query.params.length ? { params: query.params } : {}),
    mode: "execute",
    title,
    requester: input.requester,
    ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (r.status !== "succeeded") {
    return { ok: false, problem: r.error?.message ?? "It didn't finish.", queryRunId: r.queryRunId };
  }
  const at = r.columns.findIndex((c) => c.name === "value");
  const n = r.columns.findIndex((c) => c.name === "n");
  const values = r.rows
    .slice(0, limit)
    .map((row) => ({ value: String(row[at] ?? ""), rows: Number(row[n] ?? 0) }))
    .filter((v) => v.value !== "");
  return { ok: true, values, more: r.rows.length > limit, queryRunId: r.queryRunId };
}

/**
 * value_lookup: which values of the named columns are like a term the user typed. Each column is read for values that
 * contain it (case-insensitive, most common first); a column with none gets its most common values instead, so a
 * country typed as "Germany" still shows a column that holds 'DE'.
 */
export async function lookupLiveValues(
  deps: GatewayDeps,
  input: LiveRead & { term: string; columns: string[] },
): Promise<ColumnValues[]> {
  const term = input.term.trim().slice(0, COLUMN_SEARCH_CHARS);
  const columns = [...new Set(input.columns.map((c) => c.trim()).filter(Boolean))].slice(0, LIVE_VALUES.columns);
  const out: ColumnValues[] = [];
  for (const column of columns) {
    const like = term
      ? await readValues(deps, input, column, term, LIVE_VALUES.values, `Values of ${column} containing “${term}”`)
      : null;
    if (like && !like.ok) {
      out.push({ column, problem: like.problem, queryRunId: like.queryRunId });
      continue;
    }
    if (like?.values.length) {
      out.push({ column, match: "contains", values: like.values, more: like.more, queryRunId: like.queryRunId });
      continue;
    }
    const common = await readValues(
      deps,
      input,
      column,
      undefined,
      LIVE_VALUES.values,
      `Most common values of ${column}`,
    );
    out.push(
      common.ok
        ? { column, match: "common", values: common.values, more: common.more, queryRunId: common.queryRunId }
        : { column, problem: common.problem, queryRunId: common.queryRunId },
    );
  }
  return out;
}

/** A table's file (the agent's read): the most common values of its category columns, read now and not kept. */
export async function describeLiveValues(
  deps: GatewayDeps,
  input: LiveRead & { columns: string[] },
): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const column of input.columns.slice(0, LIVE_VALUES.describeColumns)) {
    const read = await readValues(
      deps,
      input,
      column,
      undefined,
      LIVE_VALUES.describeValues,
      `Most common values of ${column}`,
    );
    if (read.ok) out[column] = read.values.map((v) => v.value);
  }
  return out;
}

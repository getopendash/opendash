/**
 * Exports: an organization's rows since a date, oldest first, as CSV or JSON Lines. Every row carries its place and
 * hash in the chain, and the export starts with the chain head (JSON Lines' first line; CSV's first row), so a copy of
 * it lives outside the database. Read a page per short transaction.
 */

import { csvCell } from "@opendash/core/csv";
import type { RunAudit } from "@opendash/core/enterprise";
import { sql, uuidv7Floor } from "@opendash/db";
import { type ChainRow, hex, ROW_COLUMNS, sortedJson } from "./chain";
import { chainStatus } from "./verify";

const PAGE = 1000;

export const CSV_COLUMNS = [
  "id",
  "at",
  "actor_type",
  "actor_id",
  "actor",
  "action",
  "target_type",
  "target_id",
  "target",
  "fields",
  "detail",
  "ip",
  "user_agent",
  "seq",
  "prev_hash",
  "hash",
] as const;

export { csvCell };

function record(row: ChainRow) {
  return {
    id: row.id,
    at: row.created_at,
    actor_type: row.actor_type,
    actor_id: row.actor_id,
    actor: row.actor_name,
    action: row.action,
    target_type: row.target_type,
    target_id: row.target_id,
    target: row.target_name,
    fields: row.fields ?? [],
    detail: row.detail ?? {},
    ip: row.ip,
    user_agent: row.user_agent,
    seq: row.seq === null ? null : Number(row.seq),
    prev_hash: hex(row.prev_hash),
    hash: hex(row.hash),
  };
}

export async function* exportAudit(
  run: RunAudit,
  orgId: string,
  options: { format: "csv" | "jsonl"; since: Date },
): AsyncGenerator<string, { rows: number }, undefined> {
  const status = await chainStatus(run, orgId);
  const exportedAt = new Date().toISOString();
  if (options.format === "jsonl") {
    yield `${sortedJson({ chain: { org: orgId, seq: status.seq, head: status.head, exported_at: exportedAt, since: options.since.toISOString() } })}\n`;
  } else {
    yield `${CSV_COLUMNS.join(",")}\n`;
    yield `${["chain_head", exportedAt, "", "", "", "", "", "", "", "", "", "", "", status.seq, "", status.head ?? ""].map(csvCell).join(",")}\n`;
  }
  let rows = 0;
  let after: string | null = null;
  for (;;) {
    const page: ChainRow[] = await run((tx) =>
      tx.execute<ChainRow>(sql`
        select ${ROW_COLUMNS} from app.audit_log
        where org_id = ${orgId} and id >= ${uuidv7Floor(options.since)}::uuid
          and created_at >= ${options.since.toISOString()}::timestamptz
          ${after ? sql`and id > ${after}` : sql``}
        order by id
        limit ${PAGE}`),
    );
    for (const row of page) {
      const r = record(row);
      yield options.format === "jsonl"
        ? `${sortedJson(r)}\n`
        : `${CSV_COLUMNS.map((c) => {
            const v = r[c];
            return csvCell(Array.isArray(v) ? v.join(" ") : v && typeof v === "object" ? sortedJson(v) : v);
          }).join(",")}\n`;
      rows += 1;
    }
    if (page.length < PAGE) break;
    after = page.at(-1)?.id ?? null;
  }
  return { rows };
}

/**
 * Verify: walks an organization's chain in seq order from its first remaining row (older ones may have passed the
 * retention) and checks every link: each row follows the one before it, its content still hashes to its hash, no place
 * is missing, and the last one is the chain's head. Reads a page per short transaction, so it never holds one open.
 */
import type { AuditChainStatus, AuditVerifyResult, RunAudit } from "@opendash/core/enterprise";
import { sql } from "@opendash/db";
import { type ChainRow, hex, linkHash, ROW_COLUMNS, ZERO } from "./chain";

const PAGE = 1000;

export async function chainStatus(run: RunAudit, orgId: string): Promise<AuditChainStatus> {
  const [row] = await run((tx) =>
    tx.execute<{
      seq: string | null;
      hash: Buffer | null;
      sealed_at: string | null;
      purged_at: string | null;
      unsealed: number;
      total: number;
    }>(sql`
      select c.seq, c.hash, c.sealed_at, c.purged_at,
             (select count(*)::int from app.audit_log where org_id = ${orgId} and hash is null) as unsealed,
             (select count(*)::int from app.audit_log where org_id = ${orgId}) as total
      from (select 1) one left join app.audit_chain c on c.org_id = ${orgId}`),
  );
  return {
    seq: Number(row?.seq ?? 0),
    head: hex(row?.hash),
    sealedAt: row?.sealed_at ? new Date(row.sealed_at).toISOString() : null,
    purgedAt: row?.purged_at ? new Date(row.purged_at).toISOString() : null,
    unsealed: row?.unsealed ?? 0,
    total: row?.total ?? 0,
  };
}

export async function verifyChain(run: RunAudit, orgId: string): Promise<AuditVerifyResult> {
  const status = await chainStatus(run, orgId);
  let prev: Buffer | null = null;
  let expected = 0;
  let fromSeq = 0;
  let checked = 0;
  let after = 0;
  for (;;) {
    const rows = await run((tx) =>
      tx.execute<ChainRow>(sql`
        select ${ROW_COLUMNS} from app.audit_log
        where org_id = ${orgId} and seq is not null and seq > ${after}
        order by seq
        limit ${PAGE}`),
    );
    for (const row of rows) {
      const seq = Number(row.seq);
      const at = { id: row.id, seq };
      if (!row.prev_hash || !row.hash) return { ok: false, checked, at, reason: "Its chain columns are incomplete." };
      if (prev === null) {
        fromSeq = seq;
        if (seq === 1 && !row.prev_hash.equals(ZERO)) {
          return { ok: false, checked, at, reason: "The first event doesn't start the chain." };
        }
      } else {
        if (seq !== expected) {
          return { ok: false, checked, at, reason: `Event ${expected} is missing before this one.` };
        }
        if (!row.prev_hash.equals(prev)) {
          return { ok: false, checked, at, reason: "It doesn't follow the event before it." };
        }
      }
      if (!linkHash(row.prev_hash, row, seq).equals(row.hash)) {
        return { ok: false, checked, at, reason: "Its content changed after it was sealed." };
      }
      prev = row.hash;
      expected = seq + 1;
      checked += 1;
      after = seq;
    }
    if (rows.length < PAGE) break;
  }
  // Nothing sealed is left, though the chain has a head: retention dropped it all (the month that held the head has
  // no partition any more), or someone deleted the rows (its month is still there). Only the first is intact. Like
  // every fact in the database, the head's sealing time is the database owner's to change (as the head row itself
  // is): against the owner, the chain's proof is its head copied outside, so an aged-out answer shows it to compare.
  if (status.seq > 0 && checked === 0) {
    const [month] = await run((tx) =>
      tx.execute<{ gone: boolean }>(sql`
        select to_regclass('app.audit_log_p' || to_char(date_trunc('month', c.sealed_at - interval '5 minutes'), 'YYYYMM'))
               is null as gone
        from app.audit_chain c where c.org_id = ${orgId}`),
    );
    if (month?.gone) return { ok: true, checked: 0, fromSeq: status.seq + 1, head: status.head, agedOut: true };
  }
  if (status.seq > 0 && (after !== status.seq || hex(prev) !== status.head)) {
    return {
      ok: false,
      checked,
      at: { id: "", seq: status.seq },
      reason: `The chain's head is event ${status.seq}, but the last event found is ${after || "none"}.`,
    };
  }
  return { ok: true, checked, fromSeq: fromSeq || 1, head: status.head };
}

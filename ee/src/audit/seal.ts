/**
 * Sealing (the worker's minute tick): each organization's rows written since the last seal, oldest first, get their
 * place in its chain, the hash before them and their own. One organization per transaction, holding its chain head
 * with FOR UPDATE SKIP LOCKED (never waiting), and advancing it only from the seq it read, so a second sealer can never
 * fork a chain. A row committed late with an older id simply gets the next place: the chain's order is seq, not id.
 */
import { type SystemTx, sql } from "@opendash/db";
import { type ChainRow, linkHash, ROW_COLUMNS, ZERO } from "./chain";

/** Per call: the organizations with rows waiting, and the rows sealed for each, so a tick stays well under a minute. */
export const SEAL_LIMITS = { orgs: 50, rows: 2000 } as const;

type WithSystem = <T>(fn: (tx: SystemTx) => Promise<T>) => Promise<T>;

export async function sealOrg(
  withSystem: WithSystem,
  orgId: string,
  limit: number = SEAL_LIMITS.rows,
): Promise<number> {
  return withSystem(async (tx) => {
    await tx.execute(sql`insert into app.audit_chain (org_id) values (${orgId}) on conflict do nothing`);
    const [head] = await tx.execute<{ seq: string; hash: Buffer | null }>(sql`
      select seq, hash from app.audit_chain where org_id = ${orgId} for update skip locked`);
    if (!head) return 0;
    const rows = await tx.execute<ChainRow>(sql`
      select ${ROW_COLUMNS} from app.audit_log
      where org_id = ${orgId} and hash is null
      order by id
      limit ${limit}`);
    if (!rows.length) return 0;
    let prev = head.hash ?? ZERO;
    let seq = Number(head.seq);
    const links = rows.map((row) => {
      seq += 1;
      const hash = linkHash(prev, row, seq);
      const link = { id: row.id, seq, prev, hash };
      prev = hash;
      return link;
    });
    await tx.execute(sql`
      update app.audit_log l set seq = v.seq, prev_hash = v.prev_hash, hash = v.hash
      from (values ${sql.join(
        links.map((l) => sql`(${l.id}::uuid, ${l.seq}::bigint, ${l.prev}::bytea, ${l.hash}::bytea)`),
        sql`, `,
      )}) as v (id, seq, prev_hash, hash)
      where l.org_id = ${orgId} and l.id = v.id`);
    const moved = await tx.execute(sql`
      update app.audit_chain set seq = ${seq}, hash = ${prev}::bytea, sealed_at = now()
      where org_id = ${orgId} and seq = ${Number(head.seq)}
      returning org_id`);
    if (moved.length !== 1) throw new Error("The audit chain's head moved while sealing: nothing was sealed.");
    return links.length;
  });
}

export async function seal(withSystem: WithSystem): Promise<{ orgs: number; rows: number }> {
  const waiting = await withSystem((tx) =>
    tx.execute<{ org_id: string }>(sql`
      select distinct org_id from app.audit_log where hash is null limit ${SEAL_LIMITS.orgs}`),
  );
  let rows = 0;
  for (const { org_id } of waiting) rows += await sealOrg(withSystem, org_id);
  return { orgs: waiting.length, rows };
}

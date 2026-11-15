/**
 * Serializing work that has no row to lock (lessons from earlier work): a transaction-scoped advisory lock, never a
 * session's, waited for at most `BUDGETS.db.lockWaitMs`. Past that the statement fails (`lock_not_available`) rather
 * than hold a pooled connection in a queue of waiters. Where a row is what's shared, lock the row instead.
 */
import { type SystemTx, sql, type TenantTx } from "@opendash/db";
import { BUDGETS } from "../budgets";

/**
 * Holds `key` until the transaction ends, waiting at most the lock budget. Only the wait for this lock is bounded: the
 * transaction's own lock_timeout is put back afterwards, so its later statements wait as they did before.
 */
export async function lockFor(tx: TenantTx | SystemTx, key: string): Promise<void> {
  const [before] = await tx.execute<{ v: string }>(sql`select current_setting('lock_timeout') as v`);
  await tx.execute(sql`select set_config('lock_timeout', ${`${BUDGETS.db.lockWaitMs}ms`}, true)`);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
  await tx.execute(sql`select set_config('lock_timeout', ${before?.v ?? "0"}, true)`);
}

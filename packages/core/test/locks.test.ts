// Serializing on a key (tenancy/locks.ts): held until the transaction ends, and waited for at most the lock budget, so
// a queue of waiters never holds pooled connections; the setting ends with the transaction.
import { sql, uuidv7 } from "@opendash/db";
import { createOrg, freshDatabase, type TestDatabase, withTenantOn } from "@opendash/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BUDGETS } from "../src";
import { lockFor } from "../src/tenancy/locks";

let t: TestDatabase;
const orgId = uuidv7();
const tenant = <T>(fn: Parameters<typeof withTenantOn<T>>[2]) => withTenantOn(t.app, { orgId, userId: null }, fn);

beforeAll(async () => {
  t = await freshDatabase();
  await createOrg(t, orgId, "Locks");
});
afterAll(async () => {
  await t?.drop();
});

describe("a lock on a key", () => {
  it("is held until its transaction ends, and a second waits at most the budget before giving up", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let taken = () => {};
    const isTaken = new Promise<void>((resolve) => {
      taken = resolve;
    });
    const first = tenant(async (tx) => {
      await lockFor(tx, `checks:${orgId}`);
      taken();
      await held;
    });
    await isTaken;
    const started = Date.now();
    const second = await tenant((tx) => lockFor(tx, `checks:${orgId}`)).then(
      () => "taken",
      (error: { code?: string; cause?: { code?: string } }) => error.cause?.code ?? error.code ?? "error",
    );
    const waited = Date.now() - started;
    expect(second).toBe("55P03");
    expect(waited).toBeGreaterThanOrEqual(BUDGETS.db.lockWaitMs - 200);
    expect(waited).toBeLessThan(BUDGETS.db.lockWaitMs + 3_000);
    release();
    await first;
    // Free again, and the budget was this transaction's only.
    expect(await tenant((tx) => lockFor(tx, `checks:${orgId}`).then(() => "taken"))).toBe("taken");
    const [after] = await tenant((tx) => tx.execute<{ lock_timeout: string }>(sql`show lock_timeout`));
    expect(after?.lock_timeout).toBe("0");
  }, 20_000);
});

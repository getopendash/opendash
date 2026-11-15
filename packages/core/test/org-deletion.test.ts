// What the product does around a deletion: the dispatcher's purge of a deleted workspace (its queued jobs and the
// history no foreign key reaches), and what goes from a workspace when someone in it deletes their account.
import { type SystemTx, sql, type TenantTx, uuidv7 } from "@opendash/db";
import { createOrg, freshDatabase, type TestDatabase, withSystemOn, withTenantOn } from "@opendash/db/testing";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentInteractiveQueue,
  createBoss,
  createLogger,
  installQueues,
  ORG_PURGE_BUDGET_MS,
  personErased,
  purgeDeletedOrgs,
} from "../src";

let t: TestDatabase;
let boss: PgBoss;
const lines: string[] = [];
const log = createLogger({}, (_level, line) => lines.push(line));
const withSystem = <T>(fn: (tx: SystemTx) => Promise<T>) => withSystemOn(t.system, fn);

async function workspace(name: string): Promise<string> {
  const id = uuidv7();
  await createOrg(t, id, name);
  return id;
}
/** A conversation with one finished run, three events and two query results behind it. */
async function conversation(
  orgId: string,
  by: string | null,
  visibility: "private" | "org",
): Promise<{ threadId: string; runId: string }> {
  const [connection, threadId, runId] = [uuidv7(), uuidv7(), uuidv7()];
  await withSystem(async (tx) => {
    await tx.execute(
      sql`insert into app.connection (org_id, id, name, dialect) values (${orgId}, ${connection}, ${`pg-${connection}`}, 'postgres')`,
    );
    await tx.execute(sql`
      insert into app.thread (org_id, id, connection_id, title, created_by, visibility)
      values (${orgId}, ${threadId}, ${connection}, 'Revenue last month', ${by}, ${visibility})`);
    await tx.execute(
      sql`insert into app.run (org_id, id, thread_id, model, status) values (${orgId}, ${runId}, ${threadId}, 'm', 'succeeded')`,
    );
    for (let seq = 1; seq <= 3; seq++) {
      await tx.execute(sql`
        insert into app.run_event (id, org_id, run_id, attempt, seq, type)
        values (${uuidv7()}, ${orgId}, ${runId}, 1, ${seq}, 'attempt_started')`);
    }
    for (let n = 0; n < 2; n++) {
      await tx.execute(sql`
        insert into app.query_run (id, org_id, connection_id, requester_type, requester_id, mode, compiled_sql, sql_hash, status)
        values (${uuidv7()}, ${orgId}, ${connection}, 'run', ${runId}, 'execute', 'select 1', 'h', 'succeeded')`);
    }
  });
  return { threadId, runId };
}
const count = async (table: string, where: string, value: string) => {
  const [row] = await t.owner.unsafe<{ n: number }[]>(`select count(*)::int as n from ${table} where ${where} = $1`, [
    value,
  ]);
  return row?.n ?? 0;
};
const jobsOf = async (orgId: string) => {
  const [row] = await t.owner<{ n: number }[]>`
    select count(*)::int as n from pgboss.job where data->>'orgId' = ${orgId}`;
  return row?.n ?? 0;
};

beforeAll(async () => {
  t = await freshDatabase();
  boss = createBoss(t.url("opendash_queue"), "worker", { supervise: false, schedule: false });
  await boss.start();
  await installQueues(boss);
}, 120_000);

afterAll(async () => {
  await boss?.stop({ graceful: false });
  await t?.drop();
});

describe("a deleted workspace", () => {
  it("loses its queued jobs and the history no foreign key reaches, and another workspace loses nothing", async () => {
    const gone = await workspace("Gone");
    const kept = await workspace("Kept");
    const a = await conversation(gone, null, "org");
    const b = await conversation(kept, null, "org");
    await boss.send(agentInteractiveQueue.name, { orgId: gone, runId: a.runId }, { singletonKey: a.runId });
    await boss.send(agentInteractiveQueue.name, { orgId: kept, runId: b.runId }, { singletonKey: b.runId });

    // Nothing is deleted yet: the purge has nothing to do, and touches nobody.
    expect(await purgeDeletedOrgs({ withSystem, boss, log })).toEqual({ purged: 0, rows: 0, jobs: 0 });
    expect(await count("app.run_event", "org_id", gone)).toBe(3);

    await t.auth.client`delete from auth.organization where id = ${gone}`;
    // Its conversation went at once; its history is what's left.
    expect(await count("app.thread", "org_id", gone)).toBe(0);
    expect(await count("app.run_event", "org_id", gone)).toBe(3);
    expect(await count("app.query_run", "org_id", gone)).toBe(2);

    lines.length = 0;
    expect(await purgeDeletedOrgs({ withSystem, boss, log })).toEqual({ purged: 1, rows: 5, jobs: 1 });
    expect(await count("app.run_event", "org_id", gone)).toBe(0);
    expect(await count("app.query_run", "org_id", gone)).toBe(0);
    expect(await jobsOf(gone)).toBe(0);
    expect(lines.join("\n")).toContain("organization purged");
    // The other workspace: its history and its job are where they were.
    expect(await count("app.run_event", "org_id", kept)).toBe(3);
    expect(await count("app.query_run", "org_id", kept)).toBe(2);
    expect(await jobsOf(kept)).toBe(1);
    // Done once: the next minute finds nothing.
    expect(await purgeDeletedOrgs({ withSystem, boss, log })).toEqual({ purged: 0, rows: 0, jobs: 0 });
  });

  it("is left for the next minute when a purge runs out of time, never marked done early", async () => {
    const gone = await workspace("Large");
    await conversation(gone, null, "org");
    await t.auth.client`delete from auth.organization where id = ${gone}`;

    // A clock that's past the budget after the first batch: one batch goes, the record stays open.
    let calls = 0;
    const clock = () => (calls++ === 0 ? 0 : ORG_PURGE_BUDGET_MS + 1);
    const first = await purgeDeletedOrgs({ withSystem, boss, log }, clock);
    expect(first.purged).toBe(0);
    const [open] = await t.owner<{ n: number }[]>`
      select count(*)::int as n from app.org_deletion where org_id = ${gone} and purged_at is null`;
    expect(open?.n).toBe(1);

    expect((await purgeDeletedOrgs({ withSystem, boss, log })).purged).toBe(1);
    expect(await count("app.run_event", "org_id", gone)).toBe(0);
  });
});

describe("someone who deleted their account", () => {
  it("takes their private conversations and dashboards with them; what the workspace shares, and others', stay", async () => {
    const acme = await workspace("Acme");
    const [maya, dave] = [uuidv7(), uuidv7()];
    const tenant = <T>(fn: (tx: TenantTx) => Promise<T>) => withTenantOn(t.app, { orgId: acme }, fn);
    const hers = await conversation(acme, maya, "private");
    const shared = await conversation(acme, maya, "org");
    const his = await conversation(acme, dave, "private");
    const [privateDash, sharedDash, madeInHers] = [uuidv7(), uuidv7(), uuidv7()];
    await withSystem(async (tx) => {
      await tx.execute(sql`
        insert into app.dashboard (org_id, id, title, owner_id, visibility, thread_id) values
          (${acme}, ${privateDash}, 'My numbers', ${maya}, 'private', null),
          (${acme}, ${sharedDash}, 'Revenue', ${maya}, 'org', null),
          (${acme}, ${madeInHers}, 'From a private conversation', ${maya}, 'org', ${hers.threadId})`);
      await tx.execute(
        sql`insert into app.member_pref (org_id, user_id) values (${acme}, ${maya}), (${acme}, ${dave})`,
      );
      await tx.execute(sql`
        insert into app.user_mark (org_id, user_id, target_type, target_id, mark)
        values (${acme}, ${maya}, 'thread', ${shared.threadId}, 'favorite')`);
    });

    expect(await tenant((tx) => personErased(tx, acme, maya))).toEqual({ threads: 1, dashboards: 1 });

    // Hers alone: the conversation, its run, its events and results, her private dashboard, her settings and marks.
    expect(await count("app.thread", "id", hers.threadId)).toBe(0);
    expect(await count("app.run", "id", hers.runId)).toBe(0);
    expect(await count("app.run_event", "run_id", hers.runId)).toBe(0);
    expect(await count("app.query_run", "requester_id", hers.runId)).toBe(0);
    expect(await count("app.dashboard", "id", privateDash)).toBe(0);
    expect(await count("app.member_pref", "user_id", maya)).toBe(0);
    expect(await count("app.user_mark", "user_id", maya)).toBe(0);
    // The workspace's: what she shared stays, and a shared dashboard outlives the private conversation it came from.
    expect(await count("app.thread", "id", shared.threadId)).toBe(1);
    expect(await count("app.run_event", "run_id", shared.runId)).toBe(3);
    expect(await count("app.dashboard", "id", sharedDash)).toBe(1);
    expect(await count("app.dashboard", "id", madeInHers)).toBe(1);
    // Someone else's private work is untouched.
    expect(await count("app.thread", "id", his.threadId)).toBe(1);
    expect(await count("app.run_event", "run_id", his.runId)).toBe(3);
    expect(await count("app.query_run", "requester_id", his.runId)).toBe(2);
    expect(await count("app.member_pref", "user_id", dave)).toBe(1);
  });
});

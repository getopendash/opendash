// Learning a source end to end: a sample connection to a seeded demo company, the catalog.sync and catalog.history
// handlers, what they write, and the failure, re-sync, override and network paths.
import { randomBytes } from "node:crypto";
import { dialectFor } from "@opendash/connectors";
import { sql, uuidv7 } from "@opendash/db";
import { createOrg, freshDatabase, type TestDatabase, withSystemOn, withTenantOn } from "@opendash/db/testing";
import { type SeededDatabase, seededDatabase } from "@opendash/evals/testing";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  catalogTable,
  catalogTree,
  connectFromTest,
  createBoss,
  createSecretStore,
  dekAad,
  demoPack,
  dispatchScheduledSyncs,
  generateDek,
  getSource,
  getSyncRun,
  installDefinitions,
  installQueues,
  listDefinitions,
  listSources,
  loadSemanticModel,
  localKek,
  mineHistory,
  removeSource,
  requestConnectionTest,
  requestSync,
  runCatalogSync,
  runConnectionTest,
  runSyncHistory,
  type SyncDeps,
  setColumnSensitivity,
  setSyncSchedule,
  settleSync,
  suggestedQuestions,
} from "../src";
import { loggableError, loggableStack } from "../src/loggable";
import { keptComment, sampleRowsFor, writeProfile } from "../src/sources/catalog";

let t: TestDatabase;
let boss: PgBoss;
let source: SeededDatabase;
const kek = localKek(randomBytes(32).toString("base64"));
const secrets = createSecretStore({ kek });
const orgId = uuidv7();
const userId = uuidv7();
const config = () => ({
  host: source.host,
  port: source.port,
  database: source.database,
  user: source.reader.user,
  sslMode: "disable" as const,
});

const tenant = <T>(fn: Parameters<typeof withTenantOn<T>>[2]) => withTenantOn(t.app, { orgId }, fn);
const deps = (overrides: Partial<SyncDeps> = {}): SyncDeps => ({
  withTenant: (org, fn) => withTenantOn(t.app, { orgId: org }, fn),
  boss,
  secrets,
  edition: "community",
  ...overrides,
});

/** Runs a queued sync the way the worker would: catalog.sync, then catalog.history. */
async function learn(connectionId: string, d = deps()) {
  const syncRunId = await tenant((tx) => requestSync({ boss }, tx, { orgId, userId }, connectionId));
  const job = { orgId, connectionId, syncRunId };
  const first = await runCatalogSync(d, job);
  const second = first === "running" ? await runSyncHistory(d, job) : null;
  return { job, first, second, run: await tenant((tx) => getSyncRun(tx, orgId, syncRunId)) };
}

const object = async (fq: string) =>
  (
    await t.owner<
      {
        id: string;
        profile: Record<string, unknown>;
        sensitivity: string;
        removed_at: Date | null;
      }[]
    >`
      select id, profile, sensitivity, removed_at from app.catalog_object
      where org_id = ${orgId} and fq_name = ${fq}`
  )[0];

let connectionId: string;

beforeAll(async () => {
  t = await freshDatabase();
  await createOrg(t, orgId, "Acme");
  const wrapped = await kek.wrap(generateDek(), dekAad(orgId, 1));
  await t.system
    .client`insert into app.org_key (org_id, version, wrapped_dek, kek_ref) values (${orgId}, 1, ${wrapped}, ${kek.ref})`;
  boss = createBoss(t.url("opendash_queue"), "worker", { supervise: false, schedule: false });
  await boss.start();
  await installQueues(boss);

  // Its scratch table carries a comment far longer than one is kept (multibyte, so a character isn't a byte).
  source = await seededDatabase(undefined, {
    setup: `create table public.scratch (id int primary key, note text);
      do $$ begin execute format('comment on table public.scratch is %L', repeat('é', 5000)); end $$`,
  });

  // The sample company is connected like any database: the check, then Connect.
  const testId = await tenant((tx) =>
    requestConnectionTest(
      { boss, secrets },
      tx,
      { orgId, userId },
      { config: config(), password: source.reader.password },
    ),
  );
  await runConnectionTest(deps(), { orgId, testId });
  connectionId = await tenant((tx) => connectFromTest({ boss }, tx, { orgId, userId }, { testId }));
}, 240_000);

afterAll(async () => {
  await boss?.stop({ graceful: false });
  await source?.drop();
  await t?.drop();
});

describe("learning a source", () => {
  it("recognises the sample company when it's connected, and starts learning it in the same commit", async () => {
    const [row] = await t.owner<{ sample: boolean; verified: boolean }[]>`
      select (config->>'sample')::boolean as sample, read_only_verified_at is not null as verified
      from app.connection where id = ${connectionId}`;
    expect(row).toEqual({ sample: true, verified: true });
    const [queued] = await t.owner<{ n: number }[]>`
      select count(*)::int as n from app.sync_run where connection_id = ${connectionId} and status = 'queued'`;
    expect(queued?.n).toBe(1);
    const learning = await tenant((tx) => getSource(tx, orgId, connectionId));
    expect(learning).toMatchObject({ status: "learning", syncStatus: "queued", tables: null, learnedAt: null });
  });

  it("reads and profiles it, writing each step, and keeps stats about its columns, never their values", async () => {
    const [queued] = await t.owner<{ id: string }[]>`select id from app.sync_run where connection_id = ${connectionId}`;
    const job = { orgId, connectionId, syncRunId: queued?.id as string };
    expect(await runCatalogSync(deps(), job)).toBe("running");
    const [handover] = await t.owner<{ n: number }[]>`
      select count(*)::int as n from pgboss.job where name = 'catalog.history' and data->>'syncRunId' = ${job.syncRunId}`;
    expect(handover?.n).toBe(1);
    expect(await runSyncHistory(deps(), job)).toBe("succeeded");

    const run = await tenant((tx) => getSyncRun(tx, orgId, job.syncRunId));
    expect(run?.status).toBe("succeeded");
    expect(run?.steps.map((s) => [s.key, s.status, s.label])).toEqual([
      ["schema", "ok", "Read the schema"],
      ["profile", "ok", "Profiled tables"],
      // The test cluster keeps no query history: the last step says what to turn on.
      ["history", "skipped", "Read how your team queries it"],
    ]);
    expect(run?.steps.at(-1)?.detail).toMatch(/^pg_stat_statements isn't installed in this database\./);
    expect(run?.facts).toMatchObject({ schemas: 3, tables: 13, truncated: false });
    expect(run?.facts.personalData).toBeGreaterThanOrEqual(4);

    expect((await object("public.accounts"))?.profile).toMatchObject({ rows: 1901, method: "statistics" });
    // A comment is kept to 2,000 characters (read to 4,000, cut on the server).
    const [scratch] = await t.owner<{ comment: string }[]>`
      select comment from app.catalog_object where org_id = ${orgId} and fq_name = 'public.scratch'`;
    expect(scratch?.comment).toBe("é".repeat(2000));
    const accountRef = (await object("public.subscriptions.account_id"))?.profile.references;
    expect(accountRef).toMatchObject({ table: "accounts", column: "id", declared: true });

    const email = await object("public.users.email");
    expect(email).toMatchObject({ sensitivity: "pii" });

    // Stats, roles and freshness are kept; no column's values are, in its profile or anywhere else.
    const country = await object("public.accounts.country");
    expect(country?.profile).toMatchObject({ ndv: 8, roles: expect.arrayContaining(["category"]) });
    expect((await object("public.accounts"))?.profile.freshness).toMatchObject({ column: expect.any(String) });
    const [copies] = await t.owner<{ profiles: number; index: string | null }[]>`
      select (select count(*) from app.catalog_object where connection_id = ${connectionId} and kind = 'column'
                and (profile ? 'top' or profile ? 'min' or profile ? 'max' or profile ? 'maxValue'))::int as profiles,
             to_regclass('app.column_value')::text as index`;
    expect(copies).toEqual({ profiles: 0, index: null });
  });

  it("summarises it for the Sources list: healthy, what was learned, how fresh the data is", async () => {
    const [summary] = await tenant((tx) => listSources(tx, orgId));
    expect(summary).toMatchObject({
      id: connectionId,
      dialect: "postgres",
      sample: true,
      status: "healthy",
      statusDetail: null,
      tables: 13,
      syncStatus: "succeeded",
    });
    expect(summary?.serverVersion).toMatch(/^\d+/);
    expect(summary?.personalData).toBeGreaterThanOrEqual(4);
    expect(summary?.learnedAt).not.toBeNull();
    expect(Number.isNaN(Date.parse(summary?.dataTo ?? ""))).toBe(false);
    expect(await tenant((tx) => getSource(tx, orgId, "not-a-uuid"))).toBeNull();
  });

  it("does nothing for a run that already ran (a duplicate delivery)", async () => {
    const [done] = await t.owner<{ id: string }[]>`select id from app.sync_run where connection_id = ${connectionId}`;
    expect(await runCatalogSync(deps(), { orgId, connectionId, syncRunId: done?.id as string })).toBeNull();
  });

  it("re-syncs: removed tables are marked, the snapshot records the diff, an admin's choice is kept", async () => {
    // An older profile holds values: the column's removal drops them.
    const note = await object("public.scratch.note");
    await t.owner`
      update app.catalog_object set profile = profile || '{"top":[{"value":"draft","freq":3}],"min":"a","max":"z"}'::jsonb
      where id = ${note?.id as string}`;
    await source.exec("drop table public.scratch");
    // A view with a value written into it: how it's built is kept, the value never is.
    await source.exec(
      "create view public.paying as select a.id, a.country from public.accounts a where a.country = 'secret-country'",
    );
    await source.exec(`grant select on public.paying to ${source.reader.user}`);
    const country = await object("public.accounts.country");
    await t.owner`update app.catalog_object set sensitivity = 'pii', sensitivity_set_by = ${userId} where id = ${country?.id as string}`;
    const { second } = await learn(connectionId);
    expect(second).toBe("succeeded");
    expect((await object("public.scratch"))?.removed_at).not.toBeNull();
    const gone = await object("public.scratch.note");
    expect(gone?.profile).not.toHaveProperty("top");
    expect(gone?.profile).not.toHaveProperty("min");
    const [snapshot] = await t.owner<{ diff: { removedTables: string[] } }[]>`
      select diff from app.schema_snapshot where connection_id = ${connectionId} order by id desc limit 1`;
    expect(snapshot?.diff.removedTables).toEqual(["public.scratch"]);
    const after = await object("public.accounts.country");
    expect(after).toMatchObject({ sensitivity: "pii" });
    const [paying] = await t.owner<{ schema_info: { definition?: string; reads?: unknown[] } }[]>`
      select schema_info from app.catalog_object where org_id = ${orgId} and fq_name = 'public.paying'`;
    expect(paying?.schema_info.reads).toEqual([{ schema: "public", name: "accounts" }]);
    expect(paying?.schema_info.definition).toMatch(/accounts/);
    expect(JSON.stringify(paying)).not.toMatch(/secret-country/);
  });

  it("fails the first step, with the reason, when the database can't be reached", async () => {
    const broken = await tenant(async (tx) => {
      const secretId = await secrets.put(tx, orgId, "connection", source.reader.password);
      const id = uuidv7();
      await tx.execute(sql`
        insert into app.connection (org_id, id, name, dialect, config, secret_id)
        values (${orgId}, ${id}, 'broken', 'postgres', ${JSON.stringify({ ...config(), port: 1 })}::jsonb, ${secretId})`);
      return id;
    });
    const { first, run } = await learn(broken);
    expect(first).toBe("failed");
    expect(run?.steps[0]).toMatchObject({ key: "schema", status: "fail" });
    expect(run?.steps[0]?.detail).toMatch(/Nothing is accepting connections/);
    expect(run?.steps.slice(1).map((s) => s.status)).toEqual(["skipped", "skipped"]);
    const summary = await tenant((tx) => getSource(tx, orgId, broken));
    expect(summary).toMatchObject({ status: "failed", learnedAt: null, tables: null });
    expect(summary?.statusDetail).toMatch(/Nothing is accepting connections/);
  });

  it("in Cloud, never reaches a private address, sample data included", async () => {
    const blocked = await learn(connectionId, deps({ edition: "cloud" }));
    expect(blocked.first).toBe("failed");
    expect(blocked.run?.steps[0]?.detail).toMatch(/private address/);
  });

  it("starts one run per source, however many times it's asked", async () => {
    const ids = await Promise.all(
      Array.from({ length: 5 }, () => tenant((tx) => requestSync({ boss }, tx, { orgId, userId }, connectionId))),
    );
    expect(new Set(ids).size).toBe(1);
    // Learned before (12 tables since scratch was dropped), so this run is a re-sync and that still shows.
    // 13: the sample company's 12 after scratch went, and the view the re-sync found.
    expect(await tenant((tx) => getSource(tx, orgId, connectionId))).toMatchObject({ status: "syncing", tables: 13 });
    await settleSync(deps(), { orgId, connectionId, syncRunId: ids[0] as string }, "failed", { message: "cleanup" });
  });

  it("the dead-letter path fails a run that never finished", async () => {
    const syncRunId = await tenant((tx) => requestSync({ boss }, tx, { orgId, userId }, connectionId));
    expect(await settleSync(deps(), { orgId, connectionId, syncRunId }, "failed", { message: "interrupted" })).toBe(
      true,
    );
    expect((await tenant((tx) => getSyncRun(tx, orgId, syncRunId)))?.status).toBe("failed");
  });

  it("logs a failed write by the database's own words, never its SQL or the values it carried", () => {
    const failed = Object.assign(
      new Error("Failed query: insert into app.column_value …\nparams: org,col,hash,acme-secret"),
      {
        cause: Object.assign(new Error('invalid byte sequence for encoding "UTF8": 0x00'), { code: "22021" }),
      },
    );
    expect(loggableError(failed)).toBe('invalid byte sequence for encoding "UTF8": 0x00 (22021)');
    expect(loggableError(new Error("Failed query: select 1\nparams: acme-secret"))).toBe("A query failed.");
    // Its stack for a log line: the frames only, never the first lines, which repeat the message.
    const thrown = new Error("Failed query: select 1\nparams: acme-secret");
    const frames = loggableStack(thrown);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.length).toBeLessThanOrEqual(8);
    for (const frame of frames) expect(frame).toMatch(/^at /);
    expect(frames.join("\n")).not.toContain("acme-secret");
    expect(loggableStack("not an error")).toEqual([]);
    // A message's own indented lines are never frames, even ones that start with "at" as SQL can.
    const sql = new Error("Failed query: select ts\n  at time zone 'UTC' as acme-secret\nparams: acme-secret");
    const sqlFrames = loggableStack(sql);
    expect(sqlFrames.length).toBeGreaterThan(0);
    expect(sqlFrames.join("\n")).not.toContain("acme-secret");
    expect(sqlFrames.join("\n")).not.toContain("time zone");
    // Nor when the stack's first line names another error than the message's (a name set after the stack was read).
    const renamed = new Error("Failed query: x\n    at acme-secret (/etc/x.js:1:2)");
    void renamed.stack;
    renamed.name = "Renamed";
    expect(loggableStack(renamed).join("\n")).not.toContain("acme-secret");
    expect(loggableError(new Error("socket hang up"))).toBe("socket hang up");
  });

  it("says only that it couldn't start when OpenDash's own database fails, never the error's SQL", async () => {
    const syncRunId = await tenant((tx) => requestSync({ boss }, tx, { orgId, userId }, connectionId));
    const failing = deps({
      secrets: {
        ...secrets,
        reveal: async () => {
          throw new Error("Failed query: update app.sync_run set … params: [secret]");
        },
      },
    });
    expect(await runCatalogSync(failing, { orgId, connectionId, syncRunId })).toBe("failed");
    const run = await tenant((tx) => getSyncRun(tx, orgId, syncRunId));
    expect(run?.message).toBe("Couldn't start learning this source. Try again.");
    expect(JSON.stringify(run)).not.toContain("Failed query");
  });

  it("a retried delivery starts a stalled run over, and the stalled one's writes change nothing", async () => {
    const syncRunId = await tenant((tx) => requestSync({ boss }, tx, { orgId, userId }, connectionId));
    const job = { orgId, connectionId, syncRunId };
    const attempt = async () =>
      (await t.owner<{ attempt: number }[]>`select attempt from app.sync_run where id = ${syncRunId}`)[0]?.attempt;
    // The first delivery reads the schema and hands over; the queue's retry of it (its delivery stalled) claims the
    // running run again and starts it over, its schema snapshot replacing the first's.
    expect(await runCatalogSync(deps(), job)).toBe("running");
    expect(await attempt()).toBe(1);
    expect(await runCatalogSync(deps(), job)).toBe("running");
    expect(await attempt()).toBe(2);
    const [snaps] = await t.owner<{ n: number }[]>`
      select count(*)::int as n from app.schema_snapshot where sync_run_id = ${syncRunId}`;
    expect(snaps?.n).toBe(1);
    // The history step claims it in turn, and finishes it.
    expect(await runSyncHistory(deps(), job)).toBe("succeeded");
    expect(await attempt()).toBe(3);
    // A write of an earlier delivery, still going, changes nothing: neither the result nor its steps.
    expect(await settleSync(deps(), { ...job, attempt: 2 }, "failed", { message: "stale" })).toBe(false);
    const run = await tenant((tx) => getSyncRun(tx, orgId, syncRunId));
    expect(run).toMatchObject({ status: "succeeded", message: null });
  });

  it("shows the catalog: schemas and tables, then a table's columns in the source's order", async () => {
    const tree = await tenant((tx) => catalogTree(tx, orgId, connectionId));
    expect(tree.map((s) => s.name)).toEqual(["billing", "public", "support"]);
    const accounts = tree.find((s) => s.name === "public")?.tables.find((t) => t.name === "accounts");
    expect(accounts).toMatchObject({ kind: "table", rows: 1901 });
    expect(accounts?.columns).toBeGreaterThan(5);
    const table = await tenant((tx) => catalogTable(tx, orgId, connectionId, accounts?.id as string));
    expect(table).toMatchObject({ schema: "public", name: "accounts", primaryKey: ["id"] });
    expect(table?.columns[0]).toMatchObject({ name: "id", roles: expect.arrayContaining(["key"]) });
    const email = table?.columns.find((c) => c.name === "billing_email");
    expect(email).toMatchObject({ sensitivity: "pii" });
    // A column's values aren't part of the catalog: no range, no value search.
    expect(email).not.toHaveProperty("min");
    expect(email).not.toHaveProperty("valuesState");
    expect(await tenant((tx) => catalogTable(tx, orgId, connectionId, "nope"))).toBeNull();
  });

  it("an admin marks a column personal, and later syncs keep the mark", async () => {
    const plan = await object("public.subscriptions.plan_id");
    expect(plan).toMatchObject({ sensitivity: "none" });
    expect(plan?.profile.top).toBeUndefined();
    const marked = await tenant((tx) =>
      setColumnSensitivity(tx, { orgId, userId }, connectionId, plan?.id as string, true),
    );
    expect(marked).toEqual({ ok: true });
    const after = await object("public.subscriptions.plan_id");
    expect(after).toMatchObject({ sensitivity: "pii" });
    expect(after?.profile.top).toBeUndefined();

    await learn(connectionId);
    const resynced = await object("public.subscriptions.plan_id");
    expect(resynced).toMatchObject({ sensitivity: "pii" });
    expect(resynced?.profile).toMatchObject({ sensitivity: "pii", sensitivityReason: "marked by an admin" });
    expect(resynced?.profile.top).toBeUndefined();

    // Cleared: profiled again by the next sync, still with no values kept.
    await tenant((tx) => setColumnSensitivity(tx, { orgId, userId }, connectionId, plan?.id as string, false));
    await learn(connectionId);
    const cleared = await object("public.subscriptions.plan_id");
    expect(cleared).toMatchObject({ sensitivity: "none" });
    expect(cleared?.profile.roles).toContain("category");
    expect(cleared?.profile.top).toBeUndefined();
  });

  it("marking the table's freshness column personal drops the table's freshness, now and on later syncs", async () => {
    const table = await object("public.accounts");
    const column = (table?.profile.freshness as { column: string } | null)?.column as string;
    expect(column).toBeTruthy();
    const target = await object(`public.accounts.${column}`);
    await tenant((tx) => setColumnSensitivity(tx, { orgId, userId }, connectionId, target?.id as string, true));
    expect((await object("public.accounts"))?.profile.freshness).toBeNull();
    await learn(connectionId);
    expect((await object("public.accounts"))?.profile.freshness).not.toMatchObject({ column });
    await tenant((tx) => setColumnSensitivity(tx, { orgId, userId }, connectionId, target?.id as string, false));
  });

  it("can't clear a secret, or change a column of another source", async () => {
    const domain = await object("public.accounts.domain");
    await t.owner`update app.catalog_object set sensitivity = 'secret' where id = ${domain?.id as string}`;
    expect(
      await tenant((tx) => setColumnSensitivity(tx, { orgId, userId }, connectionId, domain?.id as string, false)),
    ).toEqual({ ok: false, reason: "secret" });
    await t.owner`update app.catalog_object set sensitivity = 'none' where id = ${domain?.id as string}`;
    expect(
      await tenant((tx) => setColumnSensitivity(tx, { orgId, userId }, uuidv7(), domain?.id as string, true)),
    ).toEqual({ ok: false, reason: "not_found" });
  });

  it("keeps no values of a column an admin marked while a sync was profiling it", async () => {
    // A sync profiles subscriptions without the admin's choice (it read the choices before the admin made it)...
    const dialect = dialectFor("postgres");
    const session = await dialect.open(config(), source.reader.password, {
      edition: "community",
      connectTimeoutMs: 10_000,
      statementTimeoutMs: 15_000,
      applicationName: "opendash-test",
    });
    const catalog = await dialect.readCatalog(session, { maxRelations: 2000 });
    const relation = catalog.relations.find((r) => r.schema === "public" && r.name === "subscriptions");
    if (!relation) throw new Error("no subscriptions");
    const profile = await dialect.profile(session, relation, catalog, { sampleRows: 2000, categoryMaxNdv: 50 });
    await session.close();
    expect(profile.columns.plan_id?.top).toBeDefined();
    const fresh = (profile.freshness as { column: string }).column;

    // ...the admin marks plan_id and the freshness column personal, then the sync writes what it profiled.
    const plan = await object("public.subscriptions.plan_id");
    const time = await object(`public.subscriptions.${fresh}`);
    for (const c of [plan, time]) {
      await tenant((tx) => setColumnSensitivity(tx, { orgId, userId }, connectionId, c?.id as string, true));
    }
    const table = await object("public.subscriptions");
    await tenant((tx) => writeProfile(tx, { orgId, connectionId }, relation, table?.id as string, profile));
    const written = await object("public.subscriptions.plan_id");
    expect(written).toMatchObject({ sensitivity: "pii" });
    expect(written?.profile.top).toBeUndefined();
    expect((await object("public.subscriptions"))?.profile.freshness).toBeNull();

    // Nor does a column nobody marked: what was profiled in memory is written as stats only.
    expect((await object("public.subscriptions.status"))?.profile).not.toHaveProperty("top");
    for (const c of [plan, time]) {
      await tenant((tx) => setColumnSensitivity(tx, { orgId, userId }, connectionId, c?.id as string, false));
    }
  });

  it("learns sources again on their schedule: due ones start, the rest wait, disabled ones never run", async () => {
    const [created] = await t.owner<{ sync_rrule: string | null; next: Date | null }[]>`
      select sync_rrule, next_sync_at as next from app.connection where id = ${connectionId}`;
    // Connected sources start on the default schedule, daily at 02:00 UTC.
    expect(created?.sync_rrule).toBe("FREQ=DAILY;BYHOUR=2");
    expect(created?.next?.getUTCHours()).toBe(2);
    const dispatch = () =>
      dispatchScheduledSyncs({
        withSystem: (fn) => withSystemOn(t.system, fn),
        withTenant: (org, fn) => withTenantOn(t.app, { orgId: org }, fn),
        boss,
      });
    const active = () =>
      t.owner<{ n: number }[]>`
        select count(*)::int as n from app.sync_run where connection_id = ${connectionId} and status = 'queued'`;
    expect((await dispatch()).started).toBe(0);
    await t.owner`update app.connection set next_sync_at = now() - interval '1 minute' where id = ${connectionId}`;
    expect((await dispatch()).started).toBe(1);
    expect((await active())[0]?.n).toBe(1);
    const [moved] = await t.owner<
      { next: Date }[]
    >`select next_sync_at as next from app.connection where id = ${connectionId}`;
    expect(moved?.next.getTime()).toBeGreaterThan(Date.now());
    // A second dispatch finds nothing due; a disabled source is never started.
    expect((await dispatch()).started).toBe(0);
    await t.owner`update app.connection set next_sync_at = now() - interval '1 minute', status = 'disabled' where id = ${connectionId}`;
    expect((await dispatch()).started).toBe(0);
    await t.owner`update app.connection set status = 'ok' where id = ${connectionId}`;
    // Off: never due.
    const off = await tenant((tx) => setSyncSchedule(tx, { orgId }, connectionId, { every: "off" }));
    expect(off).toEqual({ ok: true, nextSyncAt: null });
    const [run] = await active();
    if (run?.n) {
      const [q] = await t.owner<{ id: string }[]>`
        select id from app.sync_run where connection_id = ${connectionId} and status = 'queued'`;
      await settleSync(deps(), { orgId, connectionId, syncRunId: q?.id as string }, "failed", { message: "cleanup" });
    }
  });

  it("suggests three questions from what was learned, never about personal data", async () => {
    const questions = await tenant((tx) => suggestedQuestions(tx, orgId, connectionId));
    expect(questions).toHaveLength(3);
    for (const q of questions) {
      expect(q).toMatch(/^[A-Z]/);
      expect(q).not.toMatch(/email|phone|full name/i);
    }
  });

  // Last: it removes the source the tests above share.
  it("removes a source: what was learned and its password go, its answers stay, a late sync writes nothing", async () => {
    const [before] = await t.owner<{ secret_id: string; name: string }[]>`
      select secret_id, name from app.connection where id = ${connectionId}`;
    expect(await tenant((tx) => removeSource(tx, { orgId }, connectionId, "wrong"))).toEqual({
      ok: false,
      reason: "name_mismatch",
    });
    // It has definitions, and a learning run is queued, when the source is removed.
    await tenant((tx) =>
      installDefinitions(tx, { orgId, userId }, connectionId, demoPack("postgres"), {
        status: "verified",
        source: "pack",
      }),
    );
    const syncRunId = await tenant((tx) => requestSync({ boss }, tx, { orgId, userId }, connectionId));
    // And the team's queries, mined from its history.
    const history = {
      ...dialectFor("postgres"),
      queryHistory: async () => ({
        available: true as const,
        statements: [{ fingerprint: "1", sql: "select count(*) from public.accounts", calls: 3, totalMs: 1 }],
      }),
    };
    const session = { close: async () => {} };
    expect(await mineHistory(deps(), { orgId, connectionId }, history, session)).toMatchObject({ status: "ok" });
    expect(await tenant((tx) => removeSource(tx, { orgId }, connectionId, before?.name as string))).toEqual({
      ok: true,
    });

    const [left] = await t.owner<{ objects: number; snapshots: number; patterns: number; secrets: number }[]>`
      select (select count(*) from app.catalog_object where connection_id = ${connectionId})::int as objects,
             (select count(*) from app.query_pattern where connection_id = ${connectionId})::int as patterns,
             (select count(*) from app.schema_snapshot where connection_id = ${connectionId})::int as snapshots,
             (select count(*) from app.secret where id = ${before?.secret_id as string})::int as secrets`;
    expect(left).toEqual({ objects: 0, snapshots: 0, patterns: 0, secrets: 0 });
    expect(await tenant((tx) => listDefinitions(tx, orgId, { connectionId }))).toEqual([]);
    expect(await tenant((tx) => loadSemanticModel(tx, orgId, connectionId))).toBeNull();
    expect(await tenant((tx) => getSource(tx, orgId, connectionId))).toBeNull();
    expect((await tenant((tx) => listSources(tx, orgId))).map((s) => s.id)).not.toContain(connectionId);
    const run = await tenant((tx) => getSyncRun(tx, orgId, syncRunId));
    expect(run).toMatchObject({ status: "failed", message: "This source was removed." });

    // The queued job is delivered anyway: nothing is written.
    expect(await runCatalogSync(deps(), { orgId, connectionId, syncRunId })).toBeNull();
    const [objects] = await t.owner<{ n: number }[]>`
      select count(*)::int as n from app.catalog_object where connection_id = ${connectionId}`;
    expect(objects?.n).toBe(0);
    // A sync already past its claim can't write either.
    const relation = { schema: "public", name: "accounts", columns: [], primaryKey: [] } as unknown as Parameters<
      typeof writeProfile
    >[2];
    await expect(
      tenant((tx) =>
        writeProfile(tx, { orgId, connectionId }, relation, uuidv7(), {
          rows: 0,
          method: "sample",
          sampled: 0,
          columns: {},
        }),
      ),
    ).rejects.toThrow(/removed/);
    // Nor can mining its history.
    expect(await mineHistory(deps(), { orgId, connectionId }, history, session)).toEqual({
      status: "skipped",
      reason: "This source was removed.",
    });
    expect(await tenant((tx) => removeSource(tx, { orgId }, connectionId, before?.name as string))).toEqual({
      ok: false,
      reason: "not_found",
    });
  });
});

describe("a table's sample", () => {
  it("holds at most 100,000 cells: a wide table is sampled in fewer rows, one too wide in none", () => {
    expect(sampleRowsFor(0)).toBe(2000);
    expect(sampleRowsFor(20)).toBe(2000);
    expect(sampleRowsFor(100)).toBe(1000);
    // Postgres's widest table.
    expect(sampleRowsFor(1600)).toBe(62);
    expect(sampleRowsFor(200_000)).toBe(0);
  });
});

describe("a comment, as it's kept", () => {
  it("is at most 2,000 characters, counted as Postgres counts them, and never ends in half of one", () => {
    expect(keptComment(null)).toBeNull();
    expect(keptComment("Orders, one row each")).toBe("Orders, one row each");
    // 2,000 characters, 2,002 UTF-16 units: kept whole.
    const emoji = `😀${"a".repeat(1998)}😀`;
    expect(keptComment(emoji)).toBe(emoji);
    expect(keptComment("😀".repeat(2001))).toBe("😀".repeat(2000));
    expect(keptComment(`${"a".repeat(1999)}😀😀`)).toBe(`${"a".repeat(1999)}😀`);
  });
});

// Choosing what OpenDash learns: a source that isn't the sample company is known first (its tables' names,
// columns, row estimates and name-based sensitivity), learns only the tables its admin picks, and a question that
// reads a table not learned profiles it first, so its personal data is refused like any other.
import { randomBytes } from "node:crypto";
import { uuidv7 } from "@opendash/db";
import { createOrg, freshDatabase, type TestDatabase, withTenantOn } from "@opendash/db/testing";
import { type SeededDatabase, seededDatabase } from "@opendash/evals/testing";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  chooseLearnedTables,
  connectFromTest,
  createBoss,
  createSecretStore,
  dekAad,
  generateDek,
  getSyncRun,
  installQueues,
  LearningProblem,
  learningChoice,
  learnPickedMeanwhile,
  localKek,
  requestConnectionTest,
  runCatalogSync,
  runConnectionTest,
  runQuery,
  runSyncHistory,
  type SyncDeps,
} from "../src";

let t: TestDatabase;
let boss: PgBoss;
let source: SeededDatabase;
const kek = localKek(randomBytes(32).toString("base64"));
const secrets = createSecretStore({ kek });
const orgId = uuidv7();
const userId = uuidv7();
let connectionId = "";
const tenant = <T>(fn: Parameters<typeof withTenantOn<T>>[2]) => withTenantOn(t.app, { orgId }, fn);
const deps = (): SyncDeps => ({
  withTenant: (org, fn) => withTenantOn(t.app, { orgId: org }, fn),
  boss,
  secrets,
  edition: "community",
});
const ctx = { orgId, userId };

/** Runs a queued sync as the worker would. */
async function learn(syncRunId: string) {
  const job = { orgId, connectionId, syncRunId };
  if ((await runCatalogSync(deps(), job)) === "running") await runSyncHistory(deps(), job);
  return tenant((tx) => getSyncRun(tx, orgId, syncRunId));
}
const object = async (fq: string) =>
  (
    await t.owner<{ learn: boolean; profile: Record<string, unknown>; sensitivity: string }[]>`
      select learn, profile, sensitivity from app.catalog_object where org_id = ${orgId} and fq_name = ${fq}`
  )[0];

beforeAll(async () => {
  t = await freshDatabase();
  await createOrg(t, orgId, "Known Co");
  const wrapped = await kek.wrap(generateDek(), dekAad(orgId, 1));
  await t.system
    .client`insert into app.org_key (org_id, version, wrapped_dek, kek_ref) values (${orgId}, 1, ${wrapped}, ${kek.ref})`;
  boss = createBoss(t.url("opendash_queue"), "worker", { supervise: false, schedule: false });
  await boss.start();
  await installQueues(boss);
  // The demo company's tables, without the comment that marks the sample company: an ordinary source.
  source = await seededDatabase(undefined, {
    setup: "do $$ begin execute format('comment on database %I is null', current_database()); end $$;",
  });
  const testId = await tenant((tx) =>
    requestConnectionTest({ boss, secrets }, tx, ctx, {
      config: {
        host: source.host,
        port: source.port,
        database: source.database,
        user: source.reader.user,
        sslMode: "disable" as const,
      },
      password: source.reader.password,
    }),
  );
  await runConnectionTest(deps(), { orgId, testId });
  connectionId = await tenant((tx) => connectFromTest({ boss }, tx, ctx, { testId }));
}, 240_000);

afterAll(async () => {
  await boss?.stop({ graceful: false });
  await source?.drop();
  await t?.drop();
});

describe("a source that isn't the sample company", () => {
  it("is known after its first sync: names, columns, row estimates, personal data by name; nothing profiled", async () => {
    const [queued] = await t.owner<{ id: string }[]>`select id from app.sync_run where connection_id = ${connectionId}`;
    const run = await learn(queued?.id as string);
    expect(run?.status).toBe("succeeded");
    expect(run?.steps.find((s) => s.key === "profile")).toMatchObject({
      status: "skipped",
      label: "Choose what OpenDash learns",
    });
    const accounts = await object("public.accounts");
    expect(accounts?.learn).toBe(false);
    expect(accounts?.profile).toEqual({ rows: 1901 });
    expect((await object("public.users.email"))?.sensitivity).toBe("pii");
    expect((await object("public.accounts.country"))?.profile).toEqual({
      textual: true,
      temporal: false,
      numeric: false,
    });
  });

  it("offers every table to choose from, the ten most useful ticked, with what each joins to", async () => {
    const choice = await tenant((tx) => learningChoice(tx, orgId, connectionId));
    expect(choice).toMatchObject({ chosen: false, sample: false });
    expect(choice?.tables.length).toBeGreaterThan(10);
    expect(choice?.tables.filter((x) => x.ticked)).toHaveLength(10);
    // Declared joins are known before any profile.
    expect(choice?.tables.find((x) => x.name === "public.subscriptions")?.joinsTo).toContain("public.accounts");
    // The tables others join to rank first, with no query history to go by.
    expect(choice?.tables.slice(0, 3).map((x) => x.name)).toContain("public.accounts");
  });

  it("learns only what its admin picks, and checks joins between them", async () => {
    await expect(tenant((tx) => chooseLearnedTables({ boss }, tx, ctx, connectionId, []))).rejects.toThrow(
      LearningProblem,
    );
    await expect(tenant((tx) => chooseLearnedTables({ boss }, tx, ctx, connectionId, ["public.nope"]))).rejects.toThrow(
      /isn't a table of this source/,
    );
    const picked = ["public.accounts", "public.subscriptions", "public.plans"];
    const { learned, syncRunId } = await tenant((tx) => chooseLearnedTables({ boss }, tx, ctx, connectionId, picked));
    expect(learned).toBe(3);
    const run = await learn(syncRunId);
    expect(run?.facts.learned).toBe(3);
    expect((await object("public.accounts"))?.profile).toMatchObject({ method: expect.any(String) });
    expect((await object("public.subscriptions.account_id"))?.profile.references).toMatchObject({ table: "accounts" });
    // A table not picked stays known, not profiled.
    expect((await object("public.users"))?.profile).not.toHaveProperty("method");
    const again = await tenant((tx) => learningChoice(tx, orgId, connectionId));
    expect(again?.chosen).toBe(true);
    expect(
      again?.tables
        .filter((x) => x.ticked)
        .map((x) => x.name)
        .sort(),
    ).toEqual([...picked].sort());
  });

  it("profiles a table a question reads before reading it, and refuses its personal data like any other", async () => {
    const ask = (sqlText: string) =>
      runQuery(deps(), {
        orgId,
        connectionId,
        sql: sqlText,
        mode: "execute",
        requester: { type: "api", id: null },
      });
    const personal = await ask("select email from public.users limit 5");
    expect(personal.status).toBe("failed");
    expect(personal.error?.message).toMatch(/personal data/);
    // It was profiled on the way, so a count of its rows reads it now, still without being learned.
    expect((await object("public.users"))?.profile).toMatchObject({ method: expect.any(String) });
    expect((await object("public.users"))?.learn).toBe(false);
    const counted = await ask("select count(*) as n from public.users");
    expect(counted.status).toBe("succeeded");
    // More than three tables not learned at once is refused, with what to do.
    const wide = await ask(
      "select count(*) from billing.invoices i, billing.payments p, billing.refunds r, billing.fx_rates f",
    );
    expect(wide.status).toBe("failed");
    expect(wide.error?.message).toMatch(/aren't learned yet/);
  });

  it("profiles a table again before reading a column added since its profile, so the column's data is checked", async () => {
    // public.users was profiled on a question's first read above, and isn't learned: no sync profiles it again.
    await source.exec("alter table public.users add column notes text");
    await source.exec("update public.users set notes = email");
    const { syncRunId } = await tenant((tx) =>
      chooseLearnedTables({ boss }, tx, ctx, connectionId, ["public.accounts", "public.subscriptions", "public.plans"]),
    );
    await learn(syncRunId);
    // The new column is known by its name only: nothing says it's personal yet.
    expect((await object("public.users.notes"))?.sensitivity).toBe("none");
    const r = await runQuery(deps(), {
      orgId,
      connectionId,
      sql: "select notes from public.users limit 5",
      mode: "execute",
      requester: { type: "api", id: null },
    });
    expect(r.status).toBe("failed");
    expect(r.error?.message).toMatch(/public\.users\.notes is personal data/);
    expect((await object("public.users.notes"))?.sensitivity).toBe("pii");
  });

  it("discards a result with a column the catalog hasn't seen yet, added since the last sync", async () => {
    // plans has no personal column, so only the new one can stop a star over it.
    await source.exec("alter table public.plans add column owner_email text default 'o@example.test'");
    try {
      const ask = (sqlText: string) =>
        runQuery(deps(), { orgId, connectionId, sql: sqlText, mode: "execute", requester: { type: "api", id: null } });
      for (const sqlText of [
        "select owner_email from public.plans limit 3",
        "select * from public.plans limit 3",
        // Unqualified and computed: no qualifier to resolve, no source column on the result.
        "select lower(owner_email) as note from public.plans limit 3",
      ]) {
        const r = await ask(sqlText);
        expect(r.status).toBe("failed");
        expect(r.error?.message).toMatch(/public\.plans\.owner_email isn't in the catalog yet/);
        expect(JSON.stringify(r)).not.toMatch(/example\.test/);
      }
    } finally {
      await source.exec("alter table public.plans drop column owner_email");
    }
  });

  it("learns a pick made while a sync ran once that sync ends, and only then", async () => {
    const { syncRunId } = await tenant((tx) =>
      chooseLearnedTables({ boss }, tx, ctx, connectionId, ["public.accounts", "public.plans"]),
    );
    // The sync starts; meanwhile its admin adds a table.
    await t.owner`update app.sync_run set status = 'running', started_at = now() - interval '1 minute' where id = ${syncRunId}`;
    await tenant((tx) =>
      chooseLearnedTables({ boss }, tx, ctx, connectionId, ["public.accounts", "public.plans", "support.tickets"]),
    );
    await t.owner`update app.sync_run set status = 'succeeded', finished_at = now() where id = ${syncRunId}`;
    const next = await learnPickedMeanwhile(deps(), { orgId, connectionId, syncRunId });
    expect(next).not.toBeNull();
    expect((await learn(next as string))?.status).toBe("succeeded");
    expect((await object("support.tickets"))?.profile).toMatchObject({ method: expect.any(String) });
    // Nothing picked meanwhile: no more syncs.
    expect(await learnPickedMeanwhile(deps(), { orgId, connectionId, syncRunId: next as string })).toBeNull();
  });
});

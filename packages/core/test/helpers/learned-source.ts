// A learned demo source for integration tests: an app database with an org, the seeded demo company, connected
// through the normal check and learned (catalog, profiles, value index), exactly as the product does it.
import { randomBytes } from "node:crypto";
import { type TenantTx, uuidv7 } from "@opendash/db";
import { createOrg, freshDatabase, type TestDatabase, withTenantOn } from "@opendash/db/testing";
import {
  type SeededClickHouse,
  type SeededDatabase,
  type SeededMySql,
  seededClickHouse,
  seededDatabase,
  seededMySql,
} from "@opendash/evals/testing";
import type { PgBoss } from "pg-boss";
import {
  connectFromTest,
  createBoss,
  createSecretStore,
  dekAad,
  generateDek,
  getSyncRun,
  installQueues,
  localKek,
  requestConnectionTest,
  runCatalogSync,
  runConnectionTest,
  runSyncHistory,
  type SecretStore,
} from "../../src";

export interface LearnedSource {
  t: TestDatabase;
  boss: PgBoss;
  dialect: "postgres" | "clickhouse" | "mysql";
  /** The Postgres copy (with dialect postgres). */
  source: SeededDatabase;
  /** The ClickHouse copy (with dialect clickhouse); its table names carry `clickhouse.prefix`. */
  clickhouse: SeededClickHouse | null;
  /** The MySQL copy (with dialect mysql); its database names carry `mysql.prefix`. */
  mysql: SeededMySql | null;
  /** What the copy asked prefixes its databases with (ClickHouse, MySQL), or "" (Postgres). */
  prefix: string;
  secrets: SecretStore;
  orgId: string;
  userId: string;
  connectionId: string;
  deps: {
    withTenant: <T>(orgId: string, fn: (tx: TenantTx) => Promise<T>) => Promise<T>;
    secrets: SecretStore;
    edition: "community";
    boss: PgBoss;
  };
  tenant: <T>(fn: (tx: TenantTx) => Promise<T>) => Promise<T>;
  /** Another source in the same organization (the Postgres copy again, under `name`), connected and learned. */
  addSource(name: string): Promise<string>;
  close(): Promise<void>;
}

export async function learnedSource(
  options: { setup?: string; dialect?: "postgres" | "clickhouse" | "mysql"; clickhouseSetup?: string[] } = {},
): Promise<LearnedSource> {
  const dialect = options.dialect ?? "postgres";
  const t = await freshDatabase();
  const orgId = uuidv7();
  const userId = uuidv7();
  await createOrg(t, orgId, "Acme");
  // Its user is the organization's owner, as Better Auth makes one: only a member's questions are answered.
  await t.auth.client`insert into auth.user (id, name, email, email_verified)
    values (${userId}, 'Owner', ${`owner-${userId}@acme.test`}, true)`;
  await t.auth.client`insert into auth.member (id, organization_id, user_id, role, created_at)
    values (${uuidv7()}, ${orgId}, ${userId}, 'owner', now())`;
  const kek = localKek(randomBytes(32).toString("base64"));
  const wrapped = await kek.wrap(generateDek(), dekAad(orgId, 1));
  await t.system
    .client`insert into app.org_key (org_id, version, wrapped_dek, kek_ref) values (${orgId}, 1, ${wrapped}, ${kek.ref})`;
  const boss = createBoss(t.url("opendash_queue"), "worker", { supervise: false, schedule: false });
  await boss.start();
  await installQueues(boss);
  const secrets = createSecretStore({ kek });
  // The Postgres copy always exists: graders compute expected answers on it, whichever dialect is asked.
  const source = await seededDatabase(undefined, options.setup ? { setup: options.setup } : {});
  const clickhouse =
    dialect === "clickhouse"
      ? await seededClickHouse(options.clickhouseSetup ? { setup: options.clickhouseSetup } : {})
      : null;
  const mysql = dialect === "mysql" ? await seededMySql() : null;
  const deps = {
    withTenant: <T>(org: string, fn: (tx: TenantTx) => Promise<T>) => withTenantOn(t.app, { orgId: org }, fn),
    secrets,
    edition: "community" as const,
    boss,
  };
  const tenant = <T>(fn: (tx: TenantTx) => Promise<T>) => withTenantOn(t.app, { orgId }, fn);

  /** Connects a copy through the normal check and learns it, as the product does. */
  const connect = async (target: SeededDatabase | SeededClickHouse | SeededMySql, as: typeof dialect) => {
    const config = {
      host: target.host,
      port: target.port,
      database: target.database,
      user: target.reader.user,
      sslMode: "disable" as const,
    };
    const testId = await tenant((tx) =>
      requestConnectionTest(
        { boss, secrets },
        tx,
        { orgId, userId },
        { dialect: as, config, password: target.reader.password },
      ),
    );
    await runConnectionTest(deps, { orgId, testId });
    const id = await tenant((tx) => connectFromTest({ boss }, tx, { orgId, userId }, { testId }));
    const [run] = await t.owner<{ id: string }[]>`select id from app.sync_run where connection_id = ${id}`;
    const job = { orgId, connectionId: id, syncRunId: run?.id as string };
    await runCatalogSync(deps, job);
    await runSyncHistory(deps, job);
    const learned = await tenant((tx) => getSyncRun(tx, orgId, job.syncRunId));
    if (learned?.status !== "succeeded") throw new Error(`learning the demo source failed: ${learned?.message}`);
    return id;
  };
  const connectionId = await connect(clickhouse ?? mysql ?? source, dialect);

  return {
    t,
    boss,
    dialect,
    source,
    clickhouse,
    mysql,
    prefix: clickhouse?.prefix ?? mysql?.prefix ?? "",
    secrets,
    orgId,
    userId,
    connectionId,
    deps,
    tenant,
    addSource: async (name) => {
      const id = await connect(source, "postgres");
      await t.owner`update app.connection set name = ${name} where id = ${id}`;
      return id;
    },
    close: async () => {
      await boss.stop({ graceful: false });
      await source.drop();
      await clickhouse?.drop();
      await mysql?.drop();
      await t.drop();
    },
  };
}

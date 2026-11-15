// Connecting a source end to end against a real database: the request commits a secret, a test and its job together;
// the worker handler runs the probe and settles the test; a connection is created only from a test that allows it.
import { randomBytes } from "node:crypto";
import type { ProbeResult } from "@opendash/connectors";
import { sql, uuidv7 } from "@opendash/db";
import { createOrg, freshDatabase, type TestDatabase, withTenantOn } from "@opendash/db/testing";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applySourceUpdate,
  ConnectionError,
  connectFromTest,
  connectionTestQueue,
  createBoss,
  createSecretStore,
  dekAad,
  generateDek,
  getConnectionTest,
  getSource,
  installQueues,
  latestConnectionTest,
  localKek,
  parsePostgresSettings,
  renameSource,
  requestConnectionTest,
  requestRetest,
  requestSourceUpdate,
  runConnectionTest,
  setSourceDisabled,
  settleConnectionTest,
} from "../src";
import { TEST_LIMIT } from "../src/sources/connections";

let t: TestDatabase;
let worker: PgBoss;
let producer: PgBoss;
const kek = localKek(randomBytes(32).toString("base64"));
const secrets = createSecretStore({ kek });
const orgId = uuidv7();
const userId = uuidv7();
const ctx = { orgId, userId };

const admin = new URL(
  process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://opendash_owner:opendash@127.0.0.1:5444/postgres",
);
const settings = (overrides: Record<string, string> = {}) => {
  const parsed = parsePostgresSettings({
    host: admin.hostname,
    port: admin.port || "5432",
    database: "placeholder",
    user: "opendash_app",
    sslMode: "disable",
    ...overrides,
  });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.config;
};

const tenant = <T>(fn: (tx: Parameters<Parameters<typeof withTenantOn>[2]>[0]) => Promise<T>) =>
  withTenantOn(t.app, { orgId }, fn);
const handlerDeps = (probe?: Parameters<typeof runConnectionTest>[0]["probe"]) => ({
  withTenant: <T>(org: string, fn: (tx: Parameters<Parameters<typeof withTenantOn>[2]>[0]) => Promise<T>) =>
    withTenantOn(t.app, { orgId: org }, fn),
  secrets,
  edition: "community" as const,
  probe,
});
const fakeProbe =
  (outcome: ProbeResult["outcome"], facts: ProbeResult["facts"] = {}) =>
  async (): Promise<ProbeResult> => ({
    outcome,
    checks: [],
    facts,
    message: outcome === "failed" ? "nope" : undefined,
  });

async function finishedTest(outcome: ProbeResult["outcome"], database = "acme_production") {
  const testId = await tenant((tx) =>
    requestConnectionTest({ boss: producer, secrets }, tx, ctx, { config: settings({ database }), password: "pw" }),
  );
  await runConnectionTest(handlerDeps(fakeProbe(outcome, { tables: 3 })), { orgId, testId });
  return testId;
}

beforeAll(async () => {
  t = await freshDatabase();
  await createOrg(t, orgId, "Acme");
  const wrapped = await kek.wrap(generateDek(), dekAad(orgId, 1));
  await t.system
    .client`insert into app.org_key (org_id, version, wrapped_dek, kek_ref) values (${orgId}, 1, ${wrapped}, ${kek.ref})`;
  worker = createBoss(t.url("opendash_queue"), "worker");
  await worker.start();
  await installQueues(worker);
  producer = createBoss(t.url("opendash_queue"), "producer");
  await producer.start();
}, 60_000);

afterAll(async () => {
  await producer?.stop({ graceful: false });
  await worker?.stop({ graceful: false });
  await t?.drop();
});

describe("requesting a test", () => {
  it("commits the secret, the test and its job together, as the app role", async () => {
    const testId = await tenant((tx) =>
      requestConnectionTest({ boss: producer, secrets }, tx, ctx, { config: settings(), password: "s3cret" }),
    );
    const view = await tenant((tx) => getConnectionTest(tx, orgId, testId));
    expect(view).toMatchObject({ status: "queued", checks: [], connectionId: null });
    expect(view?.config).not.toHaveProperty("password");
    const jobs = await t.owner<{ data: { orgId: string; testId: string } }[]>`
      select data from pgboss.job where name = ${connectionTestQueue.name} and data->>'testId' = ${testId}`;
    expect(jobs.map((j) => j.data)).toEqual([{ orgId, testId }]);
  });

  it("leaves no job when the transaction rolls back", async () => {
    let testId = "";
    await expect(
      tenant(async (tx) => {
        testId = await requestConnectionTest({ boss: producer, secrets }, tx, ctx, {
          config: settings(),
          password: "x",
        });
        throw new Error("roll back");
      }),
    ).rejects.toThrow("roll back");
    const jobs = await t.owner`select 1 from pgboss.job where data->>'testId' = ${testId}`;
    expect(jobs).toHaveLength(0);
  });

  it("takes an empty password as a password (users without one), stored like any other", async () => {
    const testId = await tenant((tx) =>
      requestConnectionTest({ boss: producer, secrets }, tx, ctx, { config: settings(), password: "" }),
    );
    const [row] = await t.owner<{ secret_id: string }[]>`
      select secret_id from app.connection_test where id = ${testId}`;
    const stored = await tenant((tx) => secrets.reveal(tx, ctx.orgId, row?.secret_id as string, "connection"));
    expect(stored).toBe("");
  });

  it("refuses a password that's too long", async () => {
    await expect(
      tenant((tx) =>
        requestConnectionTest({ boss: producer, secrets }, tx, ctx, { config: settings(), password: "x".repeat(2000) }),
      ),
    ).rejects.toMatchObject({ code: "PASSWORD_TOO_LONG" });
  });
});

describe("running a test (worker)", () => {
  it("probes the database and settles the test, with every step recorded", async () => {
    // opendash_app can write its own tables, so the real probe reports write access.
    const config = settings({ database: t.name });
    const testId = await tenant((tx) =>
      requestConnectionTest({ boss: producer, secrets }, tx, ctx, { config, password: "opendash" }),
    );
    expect(await runConnectionTest(handlerDeps(), { orgId, testId })).toBe("warning");
    const view = await tenant((tx) => getConnectionTest(tx, orgId, testId));
    expect(view?.status).toBe("warning");
    expect(view?.checks.map((c) => c.status)).toEqual(["ok", "ok", "warn", "ok"]);
    expect(view?.facts.writableTables).toBeGreaterThan(0);
    expect(view?.finishedAt).not.toBeNull();
  });

  it("runs a test once, however often the job is delivered", async () => {
    const testId = await finishedTest("passed");
    expect(await runConnectionTest(handlerDeps(fakeProbe("failed")), { orgId, testId })).toBeNull();
    expect((await tenant((tx) => getConnectionTest(tx, orgId, testId)))?.status).toBe("passed");
  });

  it("turns a crash into a failed test instead of throwing", async () => {
    const testId = await tenant((tx) =>
      requestConnectionTest({ boss: producer, secrets }, tx, ctx, { config: settings(), password: "pw" }),
    );
    const crashing = async (): Promise<ProbeResult> => {
      throw new Error("boom");
    };
    expect(await runConnectionTest(handlerDeps(crashing), { orgId, testId })).toBe("failed");
    const view = await tenant((tx) => getConnectionTest(tx, orgId, testId));
    expect(view).toMatchObject({ status: "failed", message: "Something went wrong while checking. Try again." });
  });

  it("the dead-letter path fails a test that never finished, and leaves finished ones alone", async () => {
    const testId = await tenant((tx) =>
      requestConnectionTest({ boss: producer, secrets }, tx, ctx, { config: settings(), password: "pw" }),
    );
    expect(await settleConnectionTest(handlerDeps(), { orgId, testId }, "failed", { message: "interrupted" })).toBe(
      true,
    );
    expect(await settleConnectionTest(handlerDeps(), { orgId, testId }, "failed", { message: "again" })).toBe(false);
    expect((await tenant((tx) => getConnectionTest(tx, orgId, testId)))?.message).toBe("interrupted");
  });

  it("a worker picks the job up from the queue", async () => {
    const testId = await tenant((tx) =>
      requestConnectionTest({ boss: producer, secrets }, tx, ctx, { config: settings(), password: "pw" }),
    );
    const done = new Promise<void>((resolve) => {
      void worker.work(connectionTestQueue.name, { pollingIntervalSeconds: 0.5 }, async ([job]) => {
        if (!job) return;
        await runConnectionTest(handlerDeps(fakeProbe("passed")), job.data as { orgId: string; testId: string });
        if ((job.data as { testId: string }).testId === testId) resolve();
      });
    });
    await done;
    // Stop polling, so later tests' direct runs aren't raced by this handler.
    await worker.offWork(connectionTestQueue.name);
    expect((await tenant((tx) => getConnectionTest(tx, orgId, testId)))?.status).toBe("passed");
  });
});

describe("connecting from a test", () => {
  it("creates a verified connection that uses the test's secret, once", async () => {
    const testId = await finishedTest("passed", "sales_db");
    const id = await tenant((tx) => connectFromTest({ boss: producer }, tx, ctx, { testId }));
    const [row] = await t.owner<
      {
        name: string;
        read_only_verified_at: Date | null;
        write_access_accepted_at: Date | null;
        same_secret: boolean;
      }[]
    >`
      select c.name, c.read_only_verified_at, c.write_access_accepted_at, c.secret_id = t.secret_id as same_secret
      from app.connection c join app.connection_test t on t.connection_id = c.id where c.id = ${id}`;
    expect(row).toMatchObject({ name: "sales_db", write_access_accepted_at: null, same_secret: true });
    expect(row?.read_only_verified_at).not.toBeNull();
    await expect(tenant((tx) => connectFromTest({ boss: producer }, tx, ctx, { testId }))).rejects.toMatchObject({
      code: "TEST_USED",
    });
  });

  it("needs write access to be accepted explicitly, and records who accepted it", async () => {
    const testId = await finishedTest("warning", "writable");
    await expect(tenant((tx) => connectFromTest({ boss: producer }, tx, ctx, { testId }))).rejects.toMatchObject({
      code: "WRITE_ACCESS_NOT_ACCEPTED",
    });
    const id = await tenant((tx) => connectFromTest({ boss: producer }, tx, ctx, { testId, acceptWriteAccess: true }));
    const [row] = await t.owner<{ read_only_verified_at: Date | null; write_access_accepted_by: string }[]>`
      select read_only_verified_at, write_access_accepted_by from app.connection where id = ${id}`;
    expect(row).toMatchObject({ read_only_verified_at: null, write_access_accepted_by: userId });
  });

  it("never connects a blocked or failed test, even when asked to accept", async () => {
    for (const [outcome, code] of [
      ["blocked", "TEST_BLOCKED"],
      ["failed", "TEST_FAILED"],
    ] as const) {
      const testId = await finishedTest(outcome);
      await expect(
        tenant((tx) => connectFromTest({ boss: producer }, tx, ctx, { testId, acceptWriteAccess: true })),
      ).rejects.toMatchObject({
        code,
      });
    }
  });

  it("refuses a stale test", async () => {
    const testId = await finishedTest("passed");
    await t.owner`update app.connection_test set finished_at = now() - interval '2 hours' where id = ${testId}`;
    const error = await tenant((tx) => connectFromTest({ boss: producer }, tx, ctx, { testId })).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ConnectionError);
    expect(error).toMatchObject({ code: "TEST_EXPIRED" });
  });

  it("names connections after the database, numbering repeats", async () => {
    const names: string[] = [];
    for (let i = 0; i < 3; i++) {
      const testId = await finishedTest("passed", "warehouse");
      const id = await tenant((tx) => connectFromTest({ boss: producer }, tx, ctx, { testId }));
      const [row] = await t.owner<{ name: string }[]>`select name from app.connection where id = ${id}`;
      names.push(row?.name ?? "");
    }
    expect(names).toEqual(["warehouse", "warehouse 2", "warehouse 3"]);
  });

  it("can't use another org's test", async () => {
    const other = uuidv7();
    await createOrg(t, other, "Other");
    const testId = await finishedTest("passed");
    await expect(
      withTenantOn(t.app, { orgId: other }, (tx) =>
        connectFromTest({ boss: producer }, tx, { orgId: other, userId }, { testId }),
      ),
    ).rejects.toMatchObject({ code: "TEST_NOT_FOUND" });
  });
});

describe("re-checking a source (Test connection)", () => {
  let id: string;
  const source = () => tenant((tx) => getSource(tx, orgId, id));
  const retest = async (outcome: ProbeResult["outcome"]) => {
    const testId = await tenant((tx) => requestRetest({ boss: producer }, tx, ctx, id));
    await runConnectionTest(handlerDeps(fakeProbe(outcome)), { orgId, testId });
    return testId;
  };

  beforeAll(async () => {
    const testId = await finishedTest("passed", "rechecked");
    id = await tenant((tx) => connectFromTest({ boss: producer }, tx, ctx, { testId }));
    // Connecting queues a learning run; finish it, so the status shows the checks rather than "learning".
    await t.owner`update app.sync_run set status = 'succeeded', finished_at = now() where connection_id = ${id}`;
  });

  it("checks the source's own settings with its own secret, and can't be used to connect again", async () => {
    const testId = await tenant((tx) => requestRetest({ boss: producer }, tx, ctx, id));
    const [row] = await t.owner<{ same_secret: boolean; connection_id: string; database: string }[]>`
      select t.secret_id = c.secret_id as same_secret, t.connection_id, t.config->>'database' as database
      from app.connection_test t join app.connection c on c.id = t.connection_id where t.id = ${testId}`;
    expect(row).toEqual({ same_secret: true, connection_id: id, database: "rechecked" });
    // A second click while it's queued gets the same check.
    expect(await tenant((tx) => requestRetest({ boss: producer }, tx, ctx, id))).toBe(testId);
    await runConnectionTest(handlerDeps(fakeProbe("passed")), { orgId, testId });
    await expect(tenant((tx) => connectFromTest({ boss: producer }, tx, ctx, { testId }))).rejects.toMatchObject({
      code: "TEST_USED",
    });
    expect((await tenant((tx) => latestConnectionTest(tx, orgId, id)))?.id).toBe(testId);
  });

  it("applies the result: write access shows, a failure puts the source in error, a pass clears it", async () => {
    await retest("warning");
    expect(await source()).toMatchObject({ status: "write_access" });
    await retest("failed");
    expect(await source()).toMatchObject({ status: "error", statusDetail: "nope" });
    await retest("passed");
    expect(await source()).toMatchObject({ status: "healthy", statusDetail: null });
  });

  it("leaves the source alone when the check never finished (the dead-letter path)", async () => {
    const testId = await tenant((tx) => requestRetest({ boss: producer }, tx, ctx, id));
    await settleConnectionTest(handlerDeps(), { orgId, testId }, "failed", { message: "interrupted" });
    expect(await source()).toMatchObject({ status: "healthy" });
  });

  it("never lets the unused-test cleanup delete the source's secret", async () => {
    await t.owner`update app.connection_test set created_at = now() - interval '2 days' where connection_id = ${id}`;
    await tenant((tx) =>
      requestConnectionTest({ boss: producer, secrets }, tx, ctx, { config: settings(), password: "pw" }),
    );
    const [row] = await t.owner<{ n: number }[]>`
      select count(*)::int as n from app.secret s join app.connection c on c.secret_id = s.id where c.id = ${id}`;
    expect(row?.n).toBe(1);
  });

  it("refuses a disabled source", async () => {
    await t.owner`update app.connection set status = 'disabled' where id = ${id}`;
    await expect(tenant((tx) => requestRetest({ boss: producer }, tx, ctx, id))).rejects.toMatchObject({
      code: "TEST_NOT_FOUND",
    });
    await t.owner`update app.connection set status = 'ok' where id = ${id}`;
  });
});

describe("changing a source (Settings, Reconnect)", () => {
  let id: string;
  const source = () => tenant((tx) => getSource(tx, orgId, id));
  const row = async () =>
    (
      await t.owner<{ secret_id: string; database: string; accepted: boolean }[]>`
        select secret_id, config->>'database' as database, write_access_accepted_at is not null as accepted
        from app.connection where id = ${id}`
    )[0];
  const update = async (
    outcome: ProbeResult["outcome"],
    overrides: Record<string, string> = {},
    /** null keeps the saved password. */
    password: string | null = "new-pw",
  ) => {
    const testId = await tenant((tx) =>
      requestSourceUpdate({ boss: producer, secrets }, tx, ctx, id, {
        config: settings({ database: "changed", ...overrides }),
        ...(password === null ? {} : { password }),
      }),
    );
    await runConnectionTest(handlerDeps(fakeProbe(outcome)), { orgId, testId });
    return testId;
  };

  beforeAll(async () => {
    const testId = await finishedTest("passed", "updatable");
    id = await tenant((tx) => connectFromTest({ boss: producer }, tx, ctx, { testId }));
    await t.owner`update app.sync_run set status = 'succeeded', finished_at = now() where connection_id = ${id}`;
  });

  it("tests new settings without touching the source, then applies them once: new secret, old one deleted", async () => {
    const before = await row();
    const failed = await update("failed");
    expect(await source()).toMatchObject({ status: "healthy", database: "updatable" });
    await expect(
      tenant((tx) => applySourceUpdate({ boss: producer }, tx, ctx, id, { testId: failed })),
    ).rejects.toMatchObject({ code: "TEST_FAILED" });

    const testId = await update("passed");
    await tenant((tx) => applySourceUpdate({ boss: producer }, tx, ctx, id, { testId }));
    const after = await row();
    expect(after?.database).toBe("changed");
    expect(after?.secret_id).not.toBe(before?.secret_id);
    const [old] = await t.owner<{ n: number }[]>`
      select count(*)::int as n from app.secret where id = ${before?.secret_id as string}`;
    expect(old?.n).toBe(0);
    // Learned before, so the new settings are learned again as a re-sync.
    expect(await source()).toMatchObject({ status: "syncing", database: "changed" });
    await expect(tenant((tx) => applySourceUpdate({ boss: producer }, tx, ctx, id, { testId }))).rejects.toMatchObject({
      code: "TEST_USED",
    });
    await t.owner`update app.sync_run set status = 'succeeded', finished_at = now() where connection_id = ${id}`;
  });

  it("keeps the saved password only on the same server", async () => {
    const before = await row();
    const kept = await update("passed", { database: "again" }, null);
    const [test] = await t.owner<{ secret_id: string }[]>`select secret_id from app.connection_test where id = ${kept}`;
    expect(test?.secret_id).toBe(before?.secret_id);
    await expect(
      tenant((tx) =>
        requestSourceUpdate({ boss: producer, secrets }, tx, ctx, id, { config: settings({ host: "elsewhere.test" }) }),
      ),
    ).rejects.toMatchObject({ code: "PASSWORD_REQUIRED" });
    // Nor over a weaker SSL mode than the source has.
    await t.owner`update app.connection set config = jsonb_set(config, '{sslMode}', '"require"') where id = ${id}`;
    await expect(
      tenant((tx) =>
        requestSourceUpdate({ boss: producer, secrets }, tx, ctx, id, { config: settings({ sslMode: "disable" }) }),
      ),
    ).rejects.toMatchObject({ code: "PASSWORD_REQUIRED" });
    // Nor, verified, trusting another CA: that CA could vouch for another server.
    await t.owner`update app.connection set config = config || ${t.owner.json({ sslMode: "verify-full", ca: TEST_CA })}
      where id = ${id}`;
    const otherCa = { ...settings({ sslMode: "verify-full" }), ca: `${TEST_CA}\n${TEST_CA}` };
    await expect(
      tenant((tx) => requestSourceUpdate({ boss: producer, secrets }, tx, ctx, id, { config: otherCa })),
    ).rejects.toMatchObject({ code: "PASSWORD_REQUIRED" });
    await expect(
      tenant((tx) =>
        requestSourceUpdate({ boss: producer, secrets }, tx, ctx, id, { config: settings({ sslMode: "verify-full" }) }),
      ),
    ).rejects.toMatchObject({ code: "PASSWORD_REQUIRED" });
    await t.owner`update app.connection set config = (config - 'ca') || '{"sslMode": "disable"}'::jsonb where id = ${id}`;
  });

  it("needs write access accepted, and then says so", async () => {
    const testId = await update("warning");
    await expect(tenant((tx) => applySourceUpdate({ boss: producer }, tx, ctx, id, { testId }))).rejects.toMatchObject({
      code: "WRITE_ACCESS_NOT_ACCEPTED",
    });
    await tenant((tx) => applySourceUpdate({ boss: producer }, tx, ctx, id, { testId, acceptWriteAccess: true }));
    expect((await row())?.accepted).toBe(true);
    await t.owner`update app.sync_run set status = 'succeeded', finished_at = now() where connection_id = ${id}`;
    expect(await source()).toMatchObject({ status: "write_access" });
  });

  it("deletes an unapplied update's own secret after a day, never the source's", async () => {
    const typed = await update("passed", {}, "typed-pw");
    const kept = await update("passed", { database: "changed" }, null);
    await t.owner`update app.connection_test set created_at = now() - interval '2 days' where id in (${typed}, ${kept})`;
    const [typedTest] = await t.owner<
      { secret_id: string }[]
    >`select secret_id from app.connection_test where id = ${typed}`;
    await tenant((tx) =>
      requestConnectionTest({ boss: producer, secrets }, tx, ctx, { config: settings(), password: "pw" }),
    );
    const [left] = await t.owner<{ typed: number; source: number }[]>`
      select (select count(*) from app.secret where id = ${typedTest?.secret_id as string})::int as typed,
             (select count(*) from app.secret s join app.connection c on c.secret_id = s.id where c.id = ${id})::int as source`;
    expect(left).toEqual({ typed: 0, source: 1 });
  });

  it("renames, with unique names, and disables and enables", async () => {
    expect(await tenant((tx) => renameSource(tx, { orgId }, id, "  Renamed source  "))).toEqual({ ok: true });
    expect((await source())?.name).toBe("Renamed source");
    expect(await tenant((tx) => renameSource(tx, { orgId }, id, "sales_db"))).toEqual({ ok: false, reason: "taken" });
    expect(await tenant((tx) => renameSource(tx, { orgId }, id, " "))).toEqual({ ok: false, reason: "invalid" });

    expect(await tenant((tx) => setSourceDisabled(tx, { orgId }, id, true))).toEqual({ ok: true });
    expect(await source()).toMatchObject({ status: "disabled" });
    await expect(tenant((tx) => requestRetest({ boss: producer }, tx, ctx, id))).rejects.toMatchObject({
      code: "TEST_NOT_FOUND",
    });
    await tenant((tx) => setSourceDisabled(tx, { orgId }, id, false));
    expect((await source())?.status).not.toBe("disabled");
  });
});

/** A test CA's certificate (public, its key thrown away). */
const TEST_CA = [
  "-----BEGIN CERTIFICATE-----",
  "MIIBejCCASGgAwIBAgIUZTGdOvCxpKSVTRQooBdpua5zrYcwCgYIKoZIzj0EAwIw",
  "EjEQMA4GA1UEAwwHVGVzdCBDQTAgFw0yNjEwMjQyMzE0MDhaGA8yMTI2MDkzMDIz",
  "MTQwOFowEjEQMA4GA1UEAwwHVGVzdCBDQTBZMBMGByqGSM49AgEGCCqGSM49AwEH",
  "A0IABJe/9Q9JcCDKRYX+sI5fjcYs13bS2TFQr18j7I005hA/6uH7Dd7eveP3mh0j",
  "HGdG4HtNSWmORwi0h69/D1E+ufqjUzBRMB0GA1UdDgQWBBSUpM3Pvvl7JWWexiCf",
  "fw0nlUtO4zAfBgNVHSMEGDAWgBSUpM3Pvvl7JWWexiCffw0nlUtO4zAPBgNVHRMB",
  "Af8EBTADAQH/MAoGCCqGSM49BAMCA0cAMEQCIDqW2aOmq3ZdOvkkWa7YhruF/+LV",
  "oLaipWAgUisFhJFeAiBzU0rqWfaSIVmub3xvl5POsLd0IVCjE/barm7hq6rUsA==",
  "-----END CERTIFICATE-----",
].join("\n");

describe("parsePostgresSettings", () => {
  it("normalises and validates what was typed; a new source verifies its server by default", () => {
    expect(parsePostgresSettings({ host: " DB.Acme.com ", database: "prod", user: "reader" })).toEqual({
      ok: true,
      config: { host: "db.acme.com", port: 5432, database: "prod", user: "reader", sslMode: "verify-full" },
    });
    const bad = parsePostgresSettings({
      host: "postgres://x",
      port: "99999",
      database: "",
      user: "u",
      sslMode: "allow",
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(Object.keys(bad.errors).sort()).toEqual(["database", "host", "port", "sslMode"]);
  });

  it("keeps a pasted CA only with verify-full, and only when it's certificates", () => {
    const typed = { host: "db.acme.com", database: "prod", user: "reader" };
    const withCa = parsePostgresSettings({ ...typed, sslMode: "verify-full", ca: `\n${TEST_CA}\n` });
    expect(withCa.ok && withCa.config.ca).toBe(TEST_CA);
    // Two certificates (a chain) are kept as both.
    const chain = parsePostgresSettings({ ...typed, sslMode: "verify-full", ca: `${TEST_CA}\n${TEST_CA}` });
    expect(chain.ok && chain.config.ca).toBe(`${TEST_CA}\n${TEST_CA}`);
    // Another mode doesn't use one: it's dropped, not kept unused.
    const require = parsePostgresSettings({ ...typed, sslMode: "require", ca: TEST_CA });
    expect(require.ok && "ca" in require.config).toBe(false);
    for (const ca of [
      "not a certificate",
      `${TEST_CA}\nand some words`,
      "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----",
      "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----",
      TEST_CA.repeat(30),
    ]) {
      const parsed = parsePostgresSettings({ ...typed, sslMode: "verify-full", ca });
      expect(parsed.ok ? null : Object.keys(parsed.errors)).toEqual(["ca"]);
    }
  });
});

describe("queue grants", () => {
  it("lets the app role enqueue but not change or delete jobs", async () => {
    const error = await t.app.db.execute(sql`delete from pgboss.job`).catch((e: { cause?: { code?: string } }) => e);
    expect((error as { cause?: { code?: string } }).cause?.code).toBe("42501");
  });
});

describe("abuse limits", () => {
  it("caps how many tests an org can start in a short time", async () => {
    const busy = uuidv7();
    await createOrg(t, busy, "Busy");
    const wrapped = await kek.wrap(generateDek(), dekAad(busy, 1));
    await t.system
      .client`insert into app.org_key (org_id, version, wrapped_dek, kek_ref) values (${busy}, 1, ${wrapped}, ${kek.ref})`;
    const request = () =>
      withTenantOn(t.app, { orgId: busy }, (tx) =>
        requestConnectionTest(
          { boss: producer, secrets },
          tx,
          { orgId: busy, userId },
          { config: settings(), password: "pw" },
        ),
      );
    for (let i = 0; i < TEST_LIMIT.max; i++) await request();
    await expect(request()).rejects.toMatchObject({ code: "TOO_MANY_TESTS" });
  });

  it("holds the cap under parallel requests", async () => {
    const racing = uuidv7();
    await createOrg(t, racing, "Racing");
    const wrapped = await kek.wrap(generateDek(), dekAad(racing, 1));
    await t.system
      .client`insert into app.org_key (org_id, version, wrapped_dek, kek_ref) values (${racing}, 1, ${wrapped}, ${kek.ref})`;
    const results = await Promise.allSettled(
      Array.from({ length: TEST_LIMIT.max + 10 }, () =>
        withTenantOn(t.app, { orgId: racing }, (tx) =>
          requestConnectionTest(
            { boss: producer, secrets },
            tx,
            { orgId: racing, userId },
            { config: settings(), password: "pw" },
          ),
        ),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(TEST_LIMIT.max);
    const [row] = await t.owner<
      { n: number }[]
    >`select count(*)::int as n from app.connection_test where org_id = ${racing}`;
    expect(row?.n).toBe(TEST_LIMIT.max);
  });
});

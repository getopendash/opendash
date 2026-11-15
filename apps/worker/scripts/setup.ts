/**
 * Readies the database for this version: the bootstrap when an admin URL is set (roles, schemas,
 * extensions), the migrations under their advisory lock, then the queues; with OPENDASH_SEED_DEMO=true, the sample
 * company as its own database, once. Run before a version starts serving: docker compose's one-shot `setup` service,
 * or Railway's pre-deploy command on the worker. Idempotent, and safe from several containers at once.
 */
import path from "node:path";
import { createBoss, installQueues } from "@opendash/core";
import { bootstrap } from "@opendash/db/bootstrap";
import { runMigrations } from "@opendash/db/migrate";
import { seedDemoPostgres } from "@opendash/evals";
import { loadRootEnv } from "../../../scripts/load-env.mjs";

loadRootEnv(path.resolve(import.meta.dirname, "../../.."));

const need = (name: string, what: string) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name} (${what}).`);
  return value;
};

try {
  const admin = process.env.DATABASE_ADMIN_URL?.trim();
  if (admin) {
    await bootstrap(admin, {
      passwords: {
        opendash_owner: process.env.OPENDASH_DB_OWNER_PASSWORD,
        opendash_app: process.env.OPENDASH_DB_APP_PASSWORD,
        opendash_system: process.env.OPENDASH_DB_SYSTEM_PASSWORD,
        opendash_auth: process.env.OPENDASH_DB_AUTH_PASSWORD,
        opendash_queue: process.env.OPENDASH_DB_QUEUE_PASSWORD,
      },
    });
    console.info("setup: roles, schemas and extensions are in place");
  } else {
    console.info("setup: no DATABASE_ADMIN_URL, so the database is taken as bootstrapped");
  }
  await runMigrations(need("DATABASE_OWNER_URL", "opendash_owner, a direct connection"));
  console.info("setup: migrations applied");
  const boss = createBoss(need("DATABASE_QUEUE_URL", "opendash_queue, a direct connection"), "worker", {
    supervise: false,
    schedule: false,
    registerInstance: false,
  });
  await boss.start();
  await installQueues(boss);
  await boss.stop({ graceful: false });
  console.info("setup: queues installed");
  if (process.env.OPENDASH_SEED_DEMO?.trim() === "true") {
    if (!admin) throw new Error("OPENDASH_SEED_DEMO needs DATABASE_ADMIN_URL: the sample is its own database there.");
    const demo = await seedDemoPostgres(admin, {
      database: "opendash_demo",
      reader: "opendash_demo_reader",
      password: need("OPENDASH_DEMO_READER_PASSWORD", "the sample database's read-only user"),
      onlyIfMissing: true,
    });
    const host = new URL(admin).hostname;
    console.info(
      demo.seeded
        ? `setup: sample company seeded (${demo.tables} tables, ${demo.rows} rows). Connect it on Data → Connect source → PostgreSQL: host ${host}, port 5432, database opendash_demo, user opendash_demo_reader, SSL disable`
        : "setup: the sample company is already there",
    );
  }
} catch (error) {
  // The message only: a connection error can carry its URL, and so its password, in other fields.
  console.error(`setup failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

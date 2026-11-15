/**
 * Readies the end-to-end browser tests' own database (`pnpm e2e`, scripts/e2e.mjs): `opendash_e2e`, made afresh just
 * before by packages/db's e2e-database, gets its roles, migrations and queues here; and the sample company as
 * `opendash_e2e_demo` with a read-only `opendash_e2e_reader`, seeded once and then left alone (it's read-only, and
 * seeding it is most of the time). Never the development database: the names are fixed here, and the URLs it's given
 * must already point at `opendash_e2e`.
 *
 * Reads E2E_ADMIN_URL (the server's admin, any database on it), DATABASE_OWNER_URL, DATABASE_QUEUE_URL and
 * E2E_DEMO_READER_PASSWORD, which the runner sets.
 */
import { createBoss, installQueues } from "@opendash/core";
import { bootstrap } from "@opendash/db/bootstrap";
import { runMigrations } from "@opendash/db/migrate";
import { seedDemoPostgres } from "@opendash/evals";

const DATABASE = "opendash_e2e";
const DEMO = "opendash_e2e_demo";
const READER = "opendash_e2e_reader";

const need = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name}.`);
  return value;
};
const on = (url: string, database: string) => {
  const to = new URL(url);
  to.pathname = `/${database}`;
  return to.toString();
};

const admin = need("E2E_ADMIN_URL");
const owner = need("DATABASE_OWNER_URL");
const queue = need("DATABASE_QUEUE_URL");
for (const url of [owner, queue]) {
  if (new URL(url).pathname !== `/${DATABASE}`) throw new Error(`The end-to-end tests only ever use ${DATABASE}.`);
}

// The roles are the server's (a developer's own, with the passwords their settings give; "opendash" on a fresh one).
await bootstrap(on(admin, DATABASE));
await runMigrations(owner);
const boss = createBoss(queue, "worker", { supervise: false, schedule: false, registerInstance: false });
await boss.start();
await installQueues(boss);
await boss.stop({ graceful: false });
console.info(`e2e: ${DATABASE} is ready`);

const demo = await seedDemoPostgres(on(admin, "postgres"), {
  database: DEMO,
  reader: READER,
  password: need("E2E_DEMO_READER_PASSWORD"),
  onlyIfMissing: true,
});
console.info(demo.seeded ? `e2e: the sample company is seeded as ${DEMO}` : `e2e: ${DEMO} is already there`);
process.exit(0);

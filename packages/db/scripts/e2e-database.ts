/**
 * Makes the end-to-end browser tests' own database afresh (`pnpm e2e`, scripts/e2e.mjs): `opendash_e2e` is dropped
 * and created empty, so each run starts from an instance nobody has joined. The name is fixed here: this never
 * touches the development database, whatever it's given. The worker's e2e-setup then readies it (roles, migrations,
 * queues) and seeds the sample company beside it.
 *
 * Reads E2E_ADMIN_URL: the server's admin, on any of its databases.
 */
import postgres from "postgres";

const DATABASE = "opendash_e2e";

const admin = process.env.E2E_ADMIN_URL?.trim();
if (!admin) throw new Error("Set E2E_ADMIN_URL (the Postgres server's admin).");
const url = new URL(admin);
url.pathname = "/postgres";

const cluster = postgres(url.toString(), { max: 1, onnotice: () => {} });
try {
  // A run left half-way (a stopped server's connections) can't hold the database: `force` ends its sessions.
  await cluster.unsafe(`drop database if exists ${DATABASE} with (force)`);
  await cluster.unsafe(`create database ${DATABASE}`);
  console.info(`e2e: ${DATABASE} made afresh`);
} finally {
  await cluster.end();
}

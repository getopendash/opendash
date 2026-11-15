import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

export const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

/** The extensions the schema uses; the bootstrap creates them (it needs an admin role), migrations only check. */
export const REQUIRED_EXTENSIONS = ["vector", "pg_trgm", "btree_gin"] as const;

/** The advisory lock every migrator takes, so containers starting together apply each migration once. */
const MIGRATE_LOCK = "opendash:migrate";

/**
 * Applies pending migrations as opendash_owner (DATABASE_OWNER_URL). Safe to run on every boot and from several
 * containers at once: they wait for one another on an advisory lock, and the later ones find nothing to apply. A
 * database that wasn't bootstrapped fails here, naming the missing extensions, before any migration runs.
 */
export async function runMigrations(ownerUrl: string): Promise<void> {
  // One connection: the lock is the session's, and the migrator's transaction runs on the same session.
  const client = postgres(ownerUrl, { max: 1, onnotice: () => {} });
  try {
    const installed = await client<{ extname: string }[]>`
      select extname from pg_extension where extname = any(${[...REQUIRED_EXTENSIONS]})`;
    const missing = REQUIRED_EXTENSIONS.filter((e) => !installed.some((r) => r.extname === e));
    if (missing.length > 0) {
      throw new Error(
        `This database doesn't have the ${missing.join(", ")} extension${missing.length > 1 ? "s" : ""}. ` +
          "Run the bootstrap first, as an admin role (DATABASE_ADMIN_URL): it creates the roles, schemas and extensions.",
      );
    }
    await client`select pg_advisory_lock(hashtext(${MIGRATE_LOCK}))`;
    try {
      await migrate(drizzle(client), { migrationsFolder, migrationsSchema: "drizzle" });
    } finally {
      await client`select pg_advisory_unlock(hashtext(${MIGRATE_LOCK}))`;
    }
  } finally {
    await client.end();
  }
}

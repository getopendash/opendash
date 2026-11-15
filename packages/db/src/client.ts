/**
 * Raw database handles. INTERNAL to @opendash/db: package.json exports only src/index.ts, so apps can't import this
 * file. All application access goes through withTenant / withSystem.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Database = ReturnType<typeof createDatabase>;

export function createDatabase(url: string, options: { pooled?: boolean; max?: number } = {}) {
  const client = postgres(url, {
    max: options.max ?? 10,
    // Transaction-mode poolers (Supavisor, PgBouncer) can't hold prepared statements across transactions.
    prepare: !options.pooled,
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => {},
  });
  return { db: drizzle(client, { schema }), client };
}

let appDatabase: Database | undefined;
let systemDatabase: Database | undefined;
let authDatabase: Database | undefined;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. See .env.example.`);
  return value;
}

/** opendash_app over the pooler (DATABASE_URL). */
export function getAppDatabase(): Database {
  appDatabase ??= createDatabase(requireEnv("DATABASE_URL"), { pooled: process.env.DATABASE_POOLED !== "false" });
  return appDatabase;
}

/** opendash_system for the dispatcher and maintenance (DATABASE_SYSTEM_URL). */
export function getSystemDatabase(): Database {
  systemDatabase ??= createDatabase(requireEnv("DATABASE_SYSTEM_URL"), { max: 4 });
  return systemDatabase;
}

/** opendash_auth for Better Auth (DATABASE_AUTH_URL). It can reach only the auth schema. */
export function getAuthDatabase(): Database {
  authDatabase ??= createDatabase(requireEnv("DATABASE_AUTH_URL"), {
    pooled: process.env.DATABASE_POOLED !== "false",
    max: 5,
  });
  return authDatabase;
}

export async function closeDatabases(): Promise<void> {
  await Promise.all([appDatabase?.client.end(), systemDatabase?.client.end(), authDatabase?.client.end()]);
  appDatabase = undefined;
  systemDatabase = undefined;
  authDatabase = undefined;
}

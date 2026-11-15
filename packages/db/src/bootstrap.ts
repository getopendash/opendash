/**
 * One-time, per-database setup that needs admin rights: roles (cluster-wide), schemas, extensions, default
 * privileges and role defaults. Idempotent. In SaaS, run once per environment with the provider's admin role; in
 * self-host and dev, `pnpm --filter @opendash/db bootstrap` does it.
 */
import postgres from "postgres";
import { REQUIRED_EXTENSIONS } from "./migrate";

export interface BootstrapOptions {
  /** Passwords for the login roles. Required for every role that doesn't exist yet, except on a local database. */
  passwords?: Partial<Record<RoleName, string>>;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const DEV_PASSWORD = "opendash";

/** The well-known dev password is only ever used for a database on this machine. */
export function isLocalDatabase(url: string): boolean {
  return LOCAL_HOSTS.has(new URL(url).hostname);
}

export const ROLES = ["opendash_owner", "opendash_app", "opendash_auth", "opendash_queue", "opendash_system"] as const;
export type RoleName = (typeof ROLES)[number];

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

/** Each role's defaults: the app's statements and idle transactions bounded (time budgets). */
export const ROLE_SETTINGS: [RoleName, string, string][] = [
  ["opendash_app", "statement_timeout", "15s"],
  ["opendash_app", "idle_in_transaction_session_timeout", "30s"],
  ["opendash_system", "statement_timeout", "60s"],
  ["opendash_system", "idle_in_transaction_session_timeout", "30s"],
];

export async function bootstrap(adminUrl: string, options: BootstrapOptions = {}): Promise<void> {
  const local = isLocalDatabase(adminUrl);
  if (!local) {
    const missing = ROLES.filter((role) => !options.passwords?.[role]);
    if (missing.length > 0) {
      throw new Error(
        `Refusing to bootstrap a non-local database without passwords for: ${missing.join(", ")}. ` +
          "Set the OPENDASH_DB_*_PASSWORD variables (see .env.example).",
      );
    }
  }
  const sql = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    const existing = new Set(
      (await sql<{ rolname: string }[]>`select rolname from pg_roles where rolname = any(${[...ROLES]})`).map(
        (r) => r.rolname,
      ),
    );
    for (const role of ROLES) {
      if (existing.has(role)) continue;
      const password = options.passwords?.[role] || (local ? DEV_PASSWORD : undefined);
      if (!password) {
        throw new Error(
          `Refusing to create ${role} without a password on a non-local database. ` +
            `Set OPENDASH_DB_${role.replace("opendash_", "").toUpperCase()}_PASSWORD.`,
        );
      }
      const attrs = role === "opendash_owner" ? "login" : "login nobypassrls";
      await sql.unsafe(`
        do $$ begin
          if not exists (select from pg_roles where rolname = '${role}') then
            create role ${role} ${attrs} password ${literal(password)};
          end if;
        end $$;`);
    }
    // Fail with the extension's name, not create extension's error, on a Postgres that doesn't ship it.
    const available = await sql<{ name: string }[]>`
      select name from pg_available_extensions where name = any(${[...REQUIRED_EXTENSIONS]})`;
    const absent = REQUIRED_EXTENSIONS.filter((e) => !available.some((r) => r.name === e));
    if (absent.length > 0) {
      throw new Error(
        `This Postgres doesn't have the ${absent.join(", ")} extension${absent.length > 1 ? "s" : ""}. ` +
          "Use one that ships pgvector (e.g. the pgvector/pgvector:pg17 image, or a managed Postgres with it).",
      );
    }
    const [row] = await sql<{ db: string }[]>`select current_database() as db`;
    const db = row?.db;
    if (!db) throw new Error("Could not read current_database()");
    await sql.unsafe(`
      -- Only OpenDash's roles reach this database: Postgres gives every role CONNECT and TEMP on a new one, and others
      -- may share the server (a self-host's sample database and its reader, say).
      revoke connect, temporary on database "${db}" from public;
      grant connect, temporary on database "${db}" to opendash_app, opendash_system, opendash_auth, opendash_queue;
      grant connect, create on database "${db}" to opendash_owner;

      create extension if not exists vector;
      create extension if not exists pg_trgm;
      create extension if not exists btree_gin;

      create schema if not exists app authorization opendash_owner;
      create schema if not exists auth authorization opendash_auth;
      create schema if not exists pgboss authorization opendash_queue;
      create schema if not exists drizzle authorization opendash_owner;
      revoke all on schema app from public;
      grant usage on schema app to opendash_app, opendash_system;

      -- Better Auth tables: created by migrations (opendash_owner), used only by opendash_auth. The app and system roles
      -- get nothing here; tenant context comes from the auth package.
      revoke all on schema auth from public;
      grant usage, create on schema auth to opendash_owner;
      grant usage on schema auth to opendash_auth;
      alter default privileges for role opendash_owner in schema auth
        grant select, insert, update, delete on tables to opendash_auth;

      -- Tables created by migrations (as opendash_owner) are usable by the app and system roles; RLS decides rows.
      alter default privileges for role opendash_owner in schema app
        grant select, insert, update, delete on tables to opendash_app, opendash_system;
      alter default privileges for role opendash_owner in schema app
        grant usage, select on sequences to opendash_app, opendash_system;
      -- Functions are not executable by PUBLIC by default; migrations grant each one explicitly.
      alter default privileges for role opendash_owner revoke execute on functions from public;
    `);
    // The roles' defaults are the cluster's, shared by every database on it: each is set only when it differs, so
    // setups running at once (each test file's database) don't rewrite one row together ("tuple concurrently
    // updated").
    for (const [role, name, value] of ROLE_SETTINGS) {
      const [set] = await sql`
        select 1 from pg_db_role_setting s join pg_roles r on r.oid = s.setrole
        where r.rolname = ${role} and s.setdatabase = 0 and ${`${name}=${value}`} = any(s.setconfig)`;
      if (!set) await sql.unsafe(`alter role ${role} set ${name} = ${literal(value)}`);
    }
  } finally {
    await sql.end();
  }
}

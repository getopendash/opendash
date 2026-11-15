import postgres from "postgres";
import { grantReader, seedSaas } from "./seed";

export interface DemoPostgresOptions {
  /** The demo's own database on the server. */
  database: string;
  /** Its read-only user, created (or given this password) here. */
  reader: string;
  password: string;
  /** Leave a database that's already there alone, its reader's password too (setup runs on every boot). */
  onlyIfMissing?: boolean;
  /** The data's end (ms since the epoch, see yesterdayEnd); by default the benchmark's fixed October 7, 2026. */
  asOf?: number;
}

const NAME = /^[a-z_][a-z0-9_]*$/;

/**
 * Creates a sample company's own database on the server `adminUrl` points at, with a read-only user, and says where to
 * load it: the URL of the new database. Used by Acme's and Lumen's seeders, with the same safety checks. Returns
 * `{ skipped: true }` when `onlyIfMissing` is set and the database is already there.
 */
export async function createDemoDatabase(
  adminUrl: string,
  options: DemoPostgresOptions,
): Promise<{ skipped: true } | { skipped: false; url: string }> {
  const { database, reader, password } = options;
  if (!NAME.test(database) || !NAME.test(reader)) {
    throw new Error("Use lowercase letters, digits and underscores for the database and user names.");
  }
  const cluster = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    const [exists] = await cluster`select 1 from pg_database where datname = ${database}`;
    if (exists && options.onlyIfMissing) return { skipped: true };
    // An existing role is reused only if it's a reader like this one: its password is about to be the sample's,
    // which is shared with whoever connects the sample, so a role with any other rights is never taken over.
    const [role] = await cluster<{ other_rights: boolean }[]>`
      select r.rolsuper or r.rolcreaterole or r.rolcreatedb or r.rolreplication or r.rolbypassrls
          or r.rolname = current_user
          or exists (select 1 from pg_auth_members m where m.member = r.oid)
          or exists (select 1 from pg_database d where d.datdba = r.oid)
          or exists (
            select 1 from pg_database d, aclexplode(d.datacl) a where a.grantee = r.oid and d.datname <> ${database})
        as other_rights
      from pg_roles r where r.rolname = ${reader}`;
    if (role?.other_rights) {
      throw new Error(
        `${reader} already exists with other rights; the sample won't take it over. Choose another user.`,
      );
    }
    if (!exists) await cluster.unsafe(`create database ${database}`);
    const literal = `'${password.replaceAll("'", "''")}'`;
    await cluster.unsafe(
      `${role ? "alter" : "create"} role ${reader} login nosuperuser nocreaterole nocreatedb password ${literal}`,
    );
    // Its reader, and nobody else (Postgres gives every role CONNECT on a new database).
    await cluster.unsafe(`revoke connect, temporary on database ${database} from public`);
    await cluster.unsafe(`grant connect on database ${database} to ${reader}`);
  } finally {
    await cluster.end();
  }
  const target = new URL(adminUrl);
  target.pathname = `/${database}`;
  return { skipped: false, url: target.toString() };
}

/**
 * Acme, the sample company, as its own database on the Postgres server `adminUrl` points at, with a read-only user: a
 * database like any customer's, connected on Data → Connect source. What `pnpm demo:seed` does (refreshing it), and
 * self-host `setup` with OPENDASH_SEED_DEMO (once).
 */
export async function seedDemoPostgres(
  adminUrl: string,
  options: DemoPostgresOptions,
): Promise<{ seeded: false } | { seeded: true; tables: number; rows: number }> {
  const created = await createDemoDatabase(adminUrl, options);
  if (created.skipped) return { seeded: false };
  const sql = postgres(created.url, { max: 1, onnotice: () => {} });
  try {
    const summary = await seedSaas(sql, undefined, options.asOf);
    await grantReader(sql, options.reader);
    const counts = Object.values(summary.tables);
    return { seeded: true, tables: counts.length, rows: counts.reduce((a, b) => a + b, 0) };
  } finally {
    await sql.end();
  }
}

import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { bootstrap } from "../src/bootstrap";
import { createDatabase, type Database } from "../src/client";
import { uuidv7 } from "../src/ids";
import { runMigrations } from "../src/migrate";

/** Admin connection to the local compose Postgres (or CI's service container). */
const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://opendash_owner:opendash@127.0.0.1:5444/postgres";

const withDatabase = (url: string, name: string) => {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
};
const asRole = (url: string, role: string, password = "opendash") => {
  const u = new URL(url);
  u.username = role;
  u.password = password;
  return u.toString();
};

export interface TestDatabase {
  name: string;
  app: Database;
  system: Database;
  auth: Database;
  owner: ReturnType<typeof postgres>;
  /** A connection URL for this database as one of the roles (e.g. opendash_queue for pg-boss). */
  url: (role: string) => string;
  drop: () => Promise<void>;
}

/** A fresh database, bootstrapped but not migrated: for tests of the migrator itself. */
export async function bootstrappedDatabase(): Promise<{
  ownerUrl: string;
  admin: ReturnType<typeof postgres>;
  drop: () => Promise<void>;
}> {
  const name = `opendash_t_${randomBytes(4).toString("hex")}`;
  const server = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  await server.unsafe(`create database ${name}`);
  await server.end();
  const dbAdminUrl = withDatabase(ADMIN_URL, name);
  await bootstrap(dbAdminUrl);
  const admin = postgres(dbAdminUrl, { max: 1, onnotice: () => {} });
  return {
    ownerUrl: asRole(dbAdminUrl, "opendash_owner"),
    admin,
    drop: async () => {
      await admin.end();
      const a = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
      await a.unsafe(`drop database if exists ${name} with (force)`);
      await a.end();
    },
  };
}

/** A fresh database: bootstrapped, migrated, with clients for opendash_app and opendash_system. */
export async function freshDatabase(): Promise<TestDatabase> {
  const name = `opendash_t_${randomBytes(4).toString("hex")}`;
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database ${name}`);
  await admin.end();

  const dbAdminUrl = withDatabase(ADMIN_URL, name);
  await bootstrap(dbAdminUrl);
  await runMigrations(asRole(dbAdminUrl, "opendash_owner"));

  const app = createDatabase(asRole(dbAdminUrl, "opendash_app"), { max: 4 });
  const system = createDatabase(asRole(dbAdminUrl, "opendash_system"), { max: 2 });
  const auth = createDatabase(asRole(dbAdminUrl, "opendash_auth"), { max: 2 });
  const owner = postgres(asRole(dbAdminUrl, "opendash_owner"), { max: 1, onnotice: () => {} });

  return {
    name,
    app,
    system,
    auth,
    owner,
    url: (role) => asRole(dbAdminUrl, role),
    drop: async () => {
      await Promise.all([app.client.end(), system.client.end(), auth.client.end(), owner.end()]);
      const a = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
      await a.unsafe(`drop database if exists ${name} with (force)`);
      await a.end();
    },
  };
}

/** Drizzle wraps driver errors ("Failed query: …"); the Postgres error is the cause. */
export async function pgError(promise: Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    const cause = (error as { cause?: { code?: string; message?: string } }).cause;
    return { code: cause?.code, message: cause?.message ?? String(error) };
  }
  throw new Error("expected the query to fail");
}

/** Creates an organization the way the auth package does: auth.organization (as opendash_auth), then app.org. */
export async function createOrg(t: TestDatabase, id: string, name: string): Promise<void> {
  await t.auth.client`
    insert into auth.organization (id, name, slug, created_at) values (${id}, ${name}, ${`org-${id}`}, now())`;
  await t.system.client`insert into app.org (id, name) values (${id}, ${name})`;
}

/** Each organization's owner, made by createOwner: for fixtures whose rows belong to a member (slack_identity). */
export const orgOwners = new Map<string, string>();

/** An owner for an organization, a member of it (as Better Auth makes them, as opendash_auth). */
export async function createOwner(t: TestDatabase, orgId: string): Promise<string> {
  const owner = uuidv7();
  await t.auth.client`
    insert into auth.user (id, name, email, email_verified) values (${owner}, 'Owner', ${`owner-${orgId}@acme.test`}, true)`;
  await t.auth.client`
    insert into auth.member (id, organization_id, user_id, role, created_at)
    values (${uuidv7()}, ${orgId}, ${owner}, 'owner', now())`;
  orgOwners.set(orgId, owner);
  return owner;
}

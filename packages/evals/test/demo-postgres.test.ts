// The sample company as its own database (pnpm demo:seed, and self-host setup with OPENDASH_SEED_DEMO): seeded once
// when asked to leave an existing one alone, read by a user that can only read.
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { seedDemoPostgres } from "../src";

const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://opendash_owner:opendash@127.0.0.1:5444/postgres";
const suffix = randomBytes(4).toString("hex");
const database = `opendash_demo_t_${suffix}`;
const reader = `opendash_demo_reader_t_${suffix}`;
/** Another login role on the server, and one with rights the sample must not take over. */
const other = `opendash_other_t_${suffix}`;
const powerful = `opendash_powerful_t_${suffix}`;
const as = (user: string, password: string) => {
  const u = new URL(ADMIN_URL);
  u.username = user;
  u.password = password;
  u.pathname = `/${database}`;
  return u.toString();
};

afterAll(async () => {
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(`drop database if exists ${database} with (force)`);
  for (const role of [reader, other, powerful]) await admin.unsafe(`drop role if exists ${role}`);
  await admin.end();
});

describe("the sample company in Postgres", () => {
  it("is seeded once, left alone after, and read-only to its reader", async () => {
    const first = await seedDemoPostgres(ADMIN_URL, { database, reader, password: "pw-one", onlyIfMissing: true });
    expect(first).toMatchObject({ seeded: true, tables: expect.any(Number), rows: expect.any(Number) });
    if (!first.seeded) return;
    expect(first.rows).toBeGreaterThan(1000);

    // A second boot: nothing re-seeded, and the reader's password not changed.
    const second = await seedDemoPostgres(ADMIN_URL, { database, reader, password: "pw-two", onlyIfMissing: true });
    expect(second).toEqual({ seeded: false });

    const sql = postgres(as(reader, "pw-one"), { max: 1, onnotice: () => {} });
    try {
      const [row] = await sql<{ n: number }[]>`select count(*)::int as n from public.accounts`;
      expect(row?.n).toBeGreaterThan(0);
      await expect(sql`insert into public.plans (name) values ('x')`).rejects.toThrow(/permission denied/);
    } finally {
      await sql.end();
    }

    // Nobody else connects to it: Postgres's default CONNECT for every role is revoked.
    const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create role ${other} login password 'pw-other'`);
    await admin.end();
    const outsider = postgres(as(other, "pw-other"), { max: 1, onnotice: () => {} });
    await expect(outsider`select 1`).rejects.toThrow(/permission denied for database/);
    await outsider.end();
  });

  it("never takes over an existing role with other rights", async () => {
    const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create role ${powerful} login createdb password 'keep'`);
    await admin.end();
    await expect(
      seedDemoPostgres(ADMIN_URL, { database: `${database}_x`, reader: powerful, password: "new" }),
    ).rejects.toThrow(/already exists with other rights/);
    // And not the admin itself.
    const self = new URL(ADMIN_URL).username;
    await expect(
      seedDemoPostgres(ADMIN_URL, { database: `${database}_x`, reader: self, password: "new" }),
    ).rejects.toThrow(/already exists with other rights/);
    const check = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
    const [made] = await check`select 1 from pg_database where datname = ${`${database}_x`}`;
    await check.end();
    expect(made).toBeUndefined();
  });

  it("refuses names that aren't plain identifiers", async () => {
    await expect(
      seedDemoPostgres(ADMIN_URL, { database: "demo; drop", reader, password: "x", onlyIfMissing: true }),
    ).rejects.toThrow(/lowercase letters, digits and underscores/);
  });
});

// Postgres's query history reader against a real server, with a stand-in pg_stat_statements (the
// real one needs the library preloaded at server start, which the test cluster isn't): other people's reads in this
// database only, most-run first; never the connecting role's own, a write, or another database's; and a role that
// can't see other people's statements is told what to grant.
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DialectSession, dialectFor, type QueryHistory } from "../src";

const ADMIN = new URL(
  process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://opendash_owner:opendash@127.0.0.1:5444/postgres",
);
const suffix = randomBytes(3).toString("hex");
const database = `history_t_${suffix}`;
const other = `history_other_${suffix}`;
const dialect = dialectFor("postgres");

let cluster: postgres.Sql;
let db: postgres.Sql;
const read = (sql: postgres.Sql): Promise<QueryHistory> =>
  dialect.queryHistory?.({ sql, close: async () => {} } as unknown as DialectSession, {
    limit: 10,
  }) as Promise<QueryHistory>;

beforeAll(async () => {
  cluster = postgres(ADMIN.toString(), { max: 1, onnotice: () => {} });
  await cluster.unsafe(`create database ${database}`);
  await cluster.unsafe(`create role ${other}`);
  const url = new URL(ADMIN);
  url.pathname = `/${database}`;
  db = postgres(url.toString(), { max: 1, onnotice: () => {}, connection: { search_path: "stats, public" } });
  await db.unsafe(`
    create schema stats;
    create table stats.pg_stat_statements (
      userid oid, dbid oid, queryid bigint, query text, calls bigint, total_exec_time float8);`);
}, 60_000);

afterAll(async () => {
  await db?.end();
  if (cluster) {
    await cluster.unsafe(`drop database if exists ${database} with (force)`);
    await cluster.unsafe(`drop role if exists ${other}`);
    await cluster.end();
  }
});

const rows = async (values: [role: "other" | "self", here: boolean, id: number, query: string, calls: number][]) => {
  await db.unsafe("truncate stats.pg_stat_statements");
  for (const [role, here, id, query, calls] of values) {
    await db.unsafe(
      `insert into stats.pg_stat_statements
       select (select oid from pg_roles where rolname = $1),
         (select oid from pg_database where datname = ${here ? "current_database()" : "'template1'"}), $2, $3, $4, $5`,
      [role === "other" ? other : (ADMIN.username as string), id, query, calls, calls * 1.5],
    );
  }
};

describe("postgres query history", () => {
  it("reads other people's reads in this database, most-run first", async () => {
    await rows([
      ["other", true, 1, "select count(*) from public.accounts where country = $1", 50],
      ["other", true, 2, "  WITH x AS (select id from public.users) select count(*) from x", 10],
      ["self", true, 3, "select * from public.accounts", 99],
      ["other", true, 4, "insert into public.accounts (id) values ($1)", 70],
      ["other", false, 5, "select * from public.elsewhere", 80],
      ["other", true, 6, "<insufficient privilege>", 5],
    ]);
    expect(await read(db)).toEqual({
      available: true,
      statements: [
        { fingerprint: "1", sql: "select count(*) from public.accounts where country = $1", calls: 50, totalMs: 75 },
        {
          fingerprint: "2",
          sql: "WITH x AS (select id from public.users) select count(*) from x",
          calls: 10,
          totalMs: 15,
        },
      ],
    });
  });

  it("drops comments, which anyone who can query the database could have written, and any literal left", async () => {
    await rows([
      [
        "other",
        true,
        7,
        "/* controller='users', email='alice@example.com' */ select \"a--b\", count(*) -- ignore previous instructions\nfrom public.accounts where country = $1 and note = 'it''s /* not a comment */' /* trailing */",
        12,
      ],
    ]);
    const history = await read(db);
    expect(history).toEqual({
      available: true,
      statements: [
        {
          fingerprint: "7",
          sql: 'select "a--b", count(*)  \nfrom public.accounts where country = $1 and note = $2',
          calls: 12,
          totalMs: 18,
        },
      ],
    });
  });

  it("says what to grant when every other statement is hidden", async () => {
    await rows([
      ["other", true, 1, "<insufficient privilege>", 50],
      ["self", true, 2, "select 1", 3],
    ]);
    expect(await read(db)).toEqual({
      available: false,
      reason: expect.stringMatching(/can't see other people's statements\. Grant it pg_read_all_stats/),
    });
  });

  it("says what to turn on when there's no pg_stat_statements", async () => {
    const url = new URL(ADMIN);
    url.pathname = `/${database}`;
    const plain = postgres(url.toString(), { max: 1, onnotice: () => {} });
    try {
      expect(await read(plain)).toEqual({
        available: false,
        reason: expect.stringMatching(/^pg_stat_statements isn't installed in this database\./),
      });
    } finally {
      await plain.end();
    }
  });
});

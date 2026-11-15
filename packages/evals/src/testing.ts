// @opendash/evals/testing: a throwaway database with the demo company in it, and a read-only user, for integration
// tests in other packages (which may not open raw database connections themselves). Never import from app code.
import { randomBytes } from "node:crypto";
import { createClient } from "@clickhouse/client";
import mysql from "mysql2/promise";
import postgres from "postgres";
import { grantReader, seedSaas } from "./saas/seed";
import { clickhouseDatabases, grantReaderClickHouse, seedSaasClickHouse } from "./saas/seed-clickhouse";
import { grantReaderMySql, mysqlDatabases, seedSaasMySql } from "./saas/seed-mysql";

export interface SeededDatabase {
  database: string;
  host: string;
  port: number;
  reader: { user: string; password: string };
  /** Runs SQL as the owner, e.g. to change the schema between syncs. */
  exec: (text: string) => Promise<void>;
  /** Reads with SQL as the owner: graders compute expected answers from the data itself. */
  query: (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
  drop: () => Promise<void>;
}

export async function seededDatabase(
  adminUrl = process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://opendash_owner:opendash@127.0.0.1:5444/postgres",
  options: { setup?: string } = {},
): Promise<SeededDatabase> {
  const admin = new URL(adminUrl);
  const suffix = randomBytes(3).toString("hex");
  const database = `seeded_t_${suffix}`;
  const reader = { user: `seeded_reader_${suffix}`, password: randomBytes(9).toString("hex") };
  const cluster = postgres(adminUrl, { max: 1, onnotice: () => {} });
  await cluster.unsafe(`create database ${database}`);
  await cluster.unsafe(`create role ${reader.user} login password '${reader.password}'`);
  const url = new URL(admin);
  url.pathname = `/${database}`;
  const owner = postgres(url.toString(), { max: 1, onnotice: () => {} });
  await seedSaas(owner);
  if (options.setup) await owner.unsafe(options.setup);
  await grantReader(owner, reader.user);
  return {
    database,
    host: admin.hostname,
    port: Number(admin.port || 5432),
    reader,
    exec: async (text) => {
      await owner.unsafe(text);
    },
    query: async (text, params = []) =>
      (await owner.unsafe(text, params as postgres.ParameterOrJSON<never>[])) as unknown as Record<string, unknown>[],
    drop: async () => {
      await owner.end();
      await cluster.unsafe(`drop database if exists ${database} with (force)`);
      await cluster.unsafe(`drop role if exists ${reader.user}`);
      await cluster.end();
    },
  };
}

export interface SeededClickHouse {
  host: string;
  port: number;
  /** The default database for a connection: the prefixed `public`, which carries the sample-data marker. */
  database: string;
  prefix: string;
  reader: { user: string; password: string };
  /** Runs a statement as the owner, e.g. to add a table between syncs. */
  exec: (query: string) => Promise<void>;
  drop: () => Promise<void>;
}

const CLICKHOUSE_ADMIN = () => process.env.TEST_CLICKHOUSE_ADMIN_URL ?? "http://opendash_owner:opendash@127.0.0.1:8124";

/** Whether the opt-in ClickHouse (`pnpm clickhouse:up`) is running; ClickHouse tests skip when it isn't. */
export async function clickhouseAvailable(): Promise<boolean> {
  const url = new URL(CLICKHOUSE_ADMIN());
  try {
    const res = await fetch(`${url.protocol}//${url.host}/ping`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

/** The demo company in ClickHouse under a random prefix, with a read-only user (readonly = 2, SELECT grants). */
export async function seededClickHouse(options: { setup?: string[] } = {}): Promise<SeededClickHouse> {
  const admin = new URL(CLICKHOUSE_ADMIN());
  const suffix = randomBytes(3).toString("hex");
  const prefix = `t${suffix}_`;
  const reader = { user: `seeded_reader_${suffix}`, password: randomBytes(9).toString("hex") };
  const client = createClient({
    url: `${admin.protocol}//${admin.host}`,
    username: decodeURIComponent(admin.username),
    password: decodeURIComponent(admin.password),
  });
  await seedSaasClickHouse(client, { prefix });
  for (const statement of options.setup ?? [])
    await client.command({ query: statement.replaceAll("{prefix}", prefix) });
  await grantReaderClickHouse(client, { name: reader.user, password: reader.password }, prefix);
  return {
    host: admin.hostname,
    port: Number(admin.port || 8123),
    database: `${prefix}public`,
    prefix,
    reader,
    exec: async (query) => {
      await client.command({ query: query.replaceAll("{prefix}", prefix) });
    },
    drop: async () => {
      for (const db of clickhouseDatabases(prefix))
        await client.command({ query: `drop database if exists \`${db}\`` });
      await client.command({ query: `drop user if exists \`${reader.user}\`` });
      await client.close();
    },
  };
}

export interface SeededMySql {
  host: string;
  port: number;
  /** The database a connection names: the prefixed `public`, whose plans table carries the sample-data marker. */
  database: string;
  prefix: string;
  reader: { user: string; password: string };
  /** Runs a statement as root, e.g. to add a table between syncs. */
  exec: (query: string) => Promise<void>;
  drop: () => Promise<void>;
}

const MYSQL_ADMIN = () => process.env.TEST_MYSQL_ADMIN_URL ?? "mysql://root:opendash@127.0.0.1:3307";

/** Whether the opt-in MySQL (`pnpm mysql:up`) is running; MySQL tests skip when it isn't. */
export async function mysqlAvailable(): Promise<boolean> {
  try {
    const conn = await mysql.createConnection({ uri: MYSQL_ADMIN(), connectTimeout: 1500 });
    await conn.end();
    return true;
  } catch {
    return false;
  }
}

/** The demo company in MySQL under a random prefix, with a read-only user (SELECT on its three databases). */
export async function seededMySql(options: { setup?: string[] } = {}): Promise<SeededMySql> {
  const admin = new URL(MYSQL_ADMIN());
  const suffix = randomBytes(3).toString("hex");
  const prefix = `t${suffix}_`;
  const reader = { user: `seeded_reader_${suffix}`, password: randomBytes(9).toString("hex") };
  const conn = await mysql.createConnection({ uri: MYSQL_ADMIN(), multipleStatements: false });
  await seedSaasMySql(conn, { prefix });
  for (const statement of options.setup ?? []) await conn.query(statement.replaceAll("{prefix}", prefix));
  await grantReaderMySql(conn, { name: reader.user, password: reader.password }, prefix);
  return {
    host: admin.hostname,
    port: Number(admin.port || 3306),
    database: `${prefix}public`,
    prefix,
    reader,
    exec: async (query) => {
      await conn.query(query.replaceAll("{prefix}", prefix));
    },
    drop: async () => {
      // The databases' foreign keys reach across them; dropping one at a time needs the checks off.
      await conn.query("set foreign_key_checks = 0");
      for (const db of mysqlDatabases(prefix)) await conn.query(`drop database if exists \`${db}\``);
      await conn.query(`drop user if exists '${reader.user}'@'%'`);
      await conn.end();
    },
  };
}

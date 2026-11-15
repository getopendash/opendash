// The Postgres connection check against real users in a throwaway database: read-only, write grants, table owners,
// superusers and the predefined roles that reach outside the database.
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Check, type PostgresConfig, type ProbeOptions, probePostgres, tlsOptions } from "../src";

const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://opendash_owner:opendash@127.0.0.1:5444/postgres";
const admin = new URL(ADMIN_URL);
const suffix = randomBytes(3).toString("hex");
const database = `probe_t_${suffix}`;
const role = (name: string) => `probe_${name}_${suffix}`;
const PASSWORD = "probe password";
const ROLES = ["reader", "writer", "owner", "writeall", "files", "createrole", "nothing"];

const config = (user: string, overrides: Partial<PostgresConfig> = {}): PostgresConfig => ({
  host: admin.hostname,
  port: Number(admin.port || 5432),
  database,
  user,
  sslMode: "disable",
  ...overrides,
});
const options: ProbeOptions = { edition: "community", connectTimeoutMs: 3000, statementTimeoutMs: 5000 };
const status = (checks: Check[]) => Object.fromEntries(checks.map((c) => [c.key, c.status]));

let cluster: ReturnType<typeof postgres>;

beforeAll(async () => {
  cluster = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  await cluster.unsafe(`create database ${database}`);
  for (const name of ROLES) await cluster.unsafe(`create role ${role(name)} login password '${PASSWORD}'`);
  await cluster.unsafe(`grant pg_write_all_data to ${role("writeall")}`);
  await cluster.unsafe(`grant pg_read_server_files to ${role("files")}`);
  await cluster.unsafe(`alter role ${role("createrole")} createrole`);

  const db = postgres({ ...pgUrl(), database, max: 1, onnotice: () => {} });
  await db.unsafe(`
    create schema sales;
    create table sales.orders (id int primary key, amount numeric, placed_at date);
    create table sales.customers (id int primary key, name text);
    create view sales.order_totals as select placed_at, sum(amount) from sales.orders group by 1;
    create table public.audit (id int);
    grant usage on schema sales to ${ROLES.map(role).join(", ")};
    grant select on all tables in schema sales to ${["reader", "writer", "owner", "writeall", "files", "createrole"].map(role).join(", ")};
    grant insert, update on sales.orders to ${role("writer")};
    alter table sales.customers owner to ${role("owner")};
  `);
  await db.end();
}, 60_000);

afterAll(async () => {
  await cluster.unsafe(`drop database if exists ${database} with (force)`);
  for (const name of ROLES) await cluster.unsafe(`drop role if exists ${role(name)}`);
  await cluster.end();
});

function pgUrl() {
  return {
    host: admin.hostname,
    port: Number(admin.port || 5432),
    username: decodeURIComponent(admin.username),
    password: decodeURIComponent(admin.password),
  };
}

describe("probePostgres", () => {
  it("passes a read-only user and reports what it can read", async () => {
    const seen: Check[][] = [];
    const result = await probePostgres(config(role("reader")), PASSWORD, {
      ...options,
      onCheck: (c) => void seen.push(c),
    });
    expect(result.outcome).toBe("passed");
    expect(status(result.checks)).toEqual({ reach: "ok", "sign-in": "ok", "read-only": "ok", catalog: "ok" });
    expect(result.facts).toMatchObject({
      user: role("reader"),
      writableTables: 0,
      tables: 3,
      schemas: 1,
      ssl: false,
      sampleData: false,
    });
    expect(result.facts.serverVersion).toMatch(/^\d+/);
    expect(result.checks.find((c) => c.key === "catalog")?.label).toBe("Found 3 tables in 1 schema");
    // Progress is reported step by step, each step running before it settles.
    expect(seen[0]?.map((c) => c.status)).toEqual(["running", "pending", "pending", "pending"]);
    expect(seen.at(-1)?.every((c) => c.status === "ok")).toBe(true);
  });

  it("warns, with the privileges and the table count, when the user can change data", async () => {
    const result = await probePostgres(config(role("writer")), PASSWORD, options);
    expect(result.outcome).toBe("warning");
    expect(result.facts).toMatchObject({ writableTables: 1, writePrivileges: ["INSERT", "UPDATE"] });
    expect(result.checks.find((c) => c.key === "read-only")).toMatchObject({
      status: "warn",
      detail: "INSERT, UPDATE on 1 table",
    });
    expect(result.checks.find((c) => c.key === "catalog")?.status).toBe("ok");
  });

  it("counts tables the user owns as writable", async () => {
    const result = await probePostgres(config(role("owner")), PASSWORD, options);
    expect(result.outcome).toBe("warning");
    expect(result.facts.writableTables).toBe(1);
    expect(result.facts.writePrivileges).toEqual(["INSERT", "UPDATE", "DELETE", "TRUNCATE"]);
  });

  it("warns on pg_write_all_data", async () => {
    const result = await probePostgres(config(role("writeall")), PASSWORD, options);
    expect(result.outcome).toBe("warning");
    expect(result.checks.find((c) => c.key === "read-only")?.detail).toBe("pg_write_all_data");
  });

  it("blocks a superuser before counting anything, so there is nothing to override", async () => {
    const result = await probePostgres(
      config(decodeURIComponent(admin.username)),
      decodeURIComponent(admin.password),
      options,
    );
    expect(result.outcome).toBe("blocked");
    expect(result.facts.blockedBy).toContain("superuser");
    expect(result.facts.writableTables).toBeUndefined();
    expect(status(result.checks)).toEqual({ reach: "ok", "sign-in": "ok", "read-only": "fail", catalog: "skipped" });
    expect(result.message).toMatch(/superuser/);
  });

  it.each([
    ["files", "pg_read_server_files"],
    ["createrole", "CREATEROLE"],
  ])("blocks a user with %s", async (name, flag) => {
    const result = await probePostgres(config(role(name)), PASSWORD, options);
    expect(result.outcome).toBe("blocked");
    expect(result.facts.blockedBy).toEqual([flag]);
  });

  it("passes a user that can read nothing, and says so on the catalog step", async () => {
    const result = await probePostgres(config(role("nothing")), PASSWORD, options);
    expect(result.outcome).toBe("passed");
    expect(result.facts.tables).toBe(0);
    expect(result.checks.find((c) => c.key === "catalog")).toMatchObject({
      status: "warn",
      label: "No readable tables",
    });
  });

  it("fails sign-in on a wrong password, without trying the later steps", async () => {
    const result = await probePostgres(config(role("reader")), "wrong", options);
    expect(result.outcome).toBe("failed");
    expect(status(result.checks)).toEqual({
      reach: "ok",
      "sign-in": "fail",
      "read-only": "skipped",
      catalog: "skipped",
    });
    expect(result.message).toBe("The user name or password is wrong.");
  });

  it("names a database that doesn't exist", async () => {
    const result = await probePostgres(config(role("reader"), { database: "no_such_db" }), PASSWORD, options);
    expect(result.message).toBe("There's no database called no_such_db.");
  });

  it("fails to reach a port nothing listens on", async () => {
    const result = await probePostgres(config(role("reader"), { port: 1 }), PASSWORD, options);
    expect(result.outcome).toBe("failed");
    expect(status(result.checks).reach).toBe("fail");
    expect(result.message).toMatch(/Nothing is accepting connections/);
  });

  it("tries each address a name resolves to (localhost is often ::1 first)", async () => {
    const result = await probePostgres(config(role("reader"), { host: "localhost" }), PASSWORD, options);
    expect(result.outcome).toBe("passed");
  });

  it("refuses private addresses in cloud before opening a connection", async () => {
    const result = await probePostgres(config(role("reader")), PASSWORD, { ...options, edition: "cloud" });
    expect(result.outcome).toBe("failed");
    expect(result.facts.latencyMs).toBeUndefined();
    expect(result.message).toMatch(/private address/);
  });
});

describe("tlsOptions", () => {
  it("verifies the certificate against the host name typed, not the address connected to", () => {
    const base = config("u");
    expect(tlsOptions({ ...base, sslMode: "disable" })).toBe(false);
    expect(tlsOptions({ ...base, host: "db.example.com", sslMode: "verify-full" })).toEqual({
      rejectUnauthorized: true,
      servername: "db.example.com",
    });
    expect(tlsOptions({ ...base, host: "db.example.com", sslMode: "require" })).toEqual({
      rejectUnauthorized: false,
      servername: "db.example.com",
    });
    // An IP: postgres.js gives TLS no host, so the check is its own, against the IP typed.
    expect(tlsOptions({ ...base, host: "10.0.0.5", sslMode: "verify-full" })).toEqual({
      rejectUnauthorized: true,
      checkServerIdentity: expect.any(Function),
    });
    expect(tlsOptions({ ...base, host: "10.0.0.5", sslMode: "require" })).toEqual({ rejectUnauthorized: false });
  });

  it("trusts a pasted CA only with verify-full, in place of the public ones", () => {
    const ca = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";
    const base = { ...config("u"), host: "db.example.com", ca };
    expect(tlsOptions({ ...base, sslMode: "verify-full" })).toEqual({
      rejectUnauthorized: true,
      servername: "db.example.com",
      ca,
    });
    expect(tlsOptions({ ...base, sslMode: "require" })).toEqual({
      rejectUnauthorized: false,
      servername: "db.example.com",
    });
  });
});

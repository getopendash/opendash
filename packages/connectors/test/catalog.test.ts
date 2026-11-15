// Reading, profiling and value-indexing a real database: the seeded demo company, plus a table that was never
// analyzed (undeclared join, free text) and one with a secret column.
import { randomBytes } from "node:crypto";
import { seedSaas } from "@opendash/evals";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type CatalogSnapshot,
  dialectFor,
  openSession,
  probePostgres,
  profileRelation,
  type RelationInfo,
  readCatalog,
} from "../src";

const ADMIN = new URL(
  process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://opendash_owner:opendash@127.0.0.1:5444/postgres",
);
const suffix = randomBytes(3).toString("hex");
const database = `catalog_t_${suffix}`;
const reader = `catalog_reader_${suffix}`;
const options = { sampleRows: 2_000, categoryMaxNdv: 50 };

let cluster: postgres.Sql;
let session: ReturnType<typeof openSession>;
let catalog: CatalogSnapshot;
const rel = (fq: string) => catalog.relations.find((r) => `${r.schema}.${r.name}` === fq) as RelationInfo;

beforeAll(async () => {
  cluster = postgres(ADMIN.toString(), { max: 1, onnotice: () => {} });
  await cluster.unsafe(`create database ${database}`);
  await cluster.unsafe(`create role ${reader} login password 'reader'`);
  const owner = new URL(ADMIN);
  owner.pathname = `/${database}`;
  const db = postgres(owner.toString(), { max: 1, onnotice: () => {} });
  await seedSaas(db);
  await db.unsafe(`
    -- Never analyzed, as the profiling test needs: with autovacuum on, Postgres analyzes it as soon as it's busy enough.
    create table public.notes (id bigint primary key, account_id bigint, body text, created_at timestamptz)
      with (autovacuum_enabled = false);
    insert into public.notes
      select g, 1 + (g % 1900), repeat('Customer asked about annual billing and seat limits. ', 2), now() - g * interval '1 hour'
      from generate_series(1, 400) g;
    create table public.integrations (id int primary key, api_token text, kind text, credentials text, ref text);
    insert into public.integrations
      select g, 'tok_' || g, case when g % 2 = 0 then 'slack' else 'hubspot' end,
        'sk_live_' || md5(g::text) || 'Q9', gen_random_uuid()::text
      from generate_series(1, 20) g;
    create table public.people (id int primary key, dob date, joined_at timestamptz);
    insert into public.people select g, date '1980-01-01' + g, now() - g * interval '1 day' from generate_series(1, 30) g;
    create table private_stuff (id int);
    -- A function the database defines: it can read any table, past every check on the query that calls it.
    create function public.peek_users() returns setof text language sql security definer as $$ select email from public.users $$;
    -- The same, behind a quoted name, a look-alike schema, an operator and a cast.
    create function public."PEEK"() returns setof text language sql security definer as $$ select email from public.users $$;
    create schema "PG_CATALOG";
    create function "PG_CATALOG".peek() returns setof text language sql security definer as $$ select email from public.users $$;
    create function public.leak(a text, b int) returns boolean language sql security definer as $$ select true $$;
    create operator public.===> (leftarg = text, rightarg = int, function = public.leak);
    create type public.mood as enum ('fine');
    create function public.text_to_mood(text) returns public.mood language sql as $$ select 'fine'::public.mood $$;
    create cast (text as public.mood) with function public.text_to_mood(text);
    create function public.looks_fine(text) returns boolean language sql security definer as $$ select true $$;
    create domain public.checked_text as text check (public.looks_fine(value));
    -- A column whose type casts by itself, through a function: never named in a query that reads it.
    create type public.feeling as enum ('calm');
    create table public.feelings (id int primary key, f public.feeling);
    insert into public.feelings values (1, 'calm');
    create function public.feeling_text(public.feeling) returns text language sql security definer
      as $$ select string_agg(email, ',') from public.users $$;
    create cast (public.feeling as text) with function public.feeling_text(public.feeling) as implicit;
    -- A type compared through a function: order by, group by and distinct run it without naming it.
    create type public.level as enum ('low', 'high');
    create table public.levels (id int primary key, l public.level);
    create function public.level_cmp(public.level, public.level) returns int language sql immutable security definer
      as $$ select 0 $$;
    create operator class public.level_ops default for type public.level using btree as
      operator 1 < (anyenum, anyenum), operator 2 <= (anyenum, anyenum), operator 3 = (anyenum, anyenum),
      operator 4 >= (anyenum, anyenum), operator 5 > (anyenum, anyenum),
      function 1 public.level_cmp(public.level, public.level);
    -- In pg_catalog, but not built in: made after initdb.
    create function pg_catalog.peek_catalog() returns setof text language sql security definer
      as $$ select email from public.users $$;
    -- A composite column with a field of that casting type, and a range whose differences call a function.
    create type public.pair as (label text, f public.feeling);
    create table public.pairs (id int primary key, p public.pair);
    create function public.num_diff(numeric, numeric) returns float8 language sql immutable as $$ select 0::float8 $$;
    create type public.num_range as range (subtype = numeric, subtype_diff = public.num_diff);
    create table public.ranges (id int primary key, r public.num_range);
    -- A composite with a field whose domain checks through a function: written as a value, never read.
    create type public.wrap as (c public.checked_text);
    -- A table's own row type, cast by itself.
    create table public.rows_cast (id int);
    create function public.row_text(public.rows_cast) returns text language sql security definer as $$ select 'x' $$;
    create cast (public.rows_cast as text) with function public.row_text(public.rows_cast) as implicit;
    -- A view with a value written into it: how it's built is kept, the value never is.
    create view public.acme_notes as
      select n.id, n.account_id from public.notes n /* ask alice@example.com */ where n.body like '%secret-plan-name%';
    -- An extension's views, readable by everyone: not the team's data.
    create extension pg_stat_statements;
    grant usage on schema public, billing, support to ${reader};
    grant select on all tables in schema public, billing, support to ${reader};
    revoke select on private_stuff from ${reader};
  `);
  await db.end();
  session = openSession(
    { host: ADMIN.hostname, port: Number(ADMIN.port || 5432), database, user: reader, sslMode: "disable" },
    ADMIN.hostname,
    "reader",
    { connectTimeoutMs: 5_000, statementTimeoutMs: 10_000, applicationName: "opendash-test" },
  );
  catalog = await readCatalog(session.sql, { maxRelations: 500 });
}, 180_000);

afterAll(async () => {
  await session?.close();
  await cluster.unsafe(`drop database if exists ${database} with (force)`);
  await cluster.unsafe(`drop role if exists ${reader}`);
  await cluster.end();
});

describe("readCatalog", () => {
  it("lists what the user can read, with keys, declared joins and row estimates", () => {
    const names = catalog.relations.map((r) => `${r.schema}.${r.name}`);
    expect(names).toEqual(expect.arrayContaining(["public.accounts", "billing.invoices", "support.tickets"]));
    expect(names).not.toContain("public.private_stuff");
    expect(names.filter((n) => n.includes("pg_stat_statements"))).toEqual([]);
    expect(catalog.schemas.map((s) => s.name).sort()).toEqual(["billing", "public", "support"]);
    const subscriptions = rel("public.subscriptions");
    expect(subscriptions.primaryKey).toEqual(["id"]);
    expect(subscriptions.foreignKeys).toContainEqual({
      columns: ["account_id"],
      refSchema: "public",
      refTable: "accounts",
      refColumns: ["id"],
    });
    expect(rel("public.accounts").rowsEstimate).toBe(1901);
    const amount = subscriptions.columns.find((c) => c.name === "amount_cents");
    expect(amount).toMatchObject({ numeric: true, nullable: false });
    expect(amount?.comment).toMatch(/cents/);
  });

  it("keeps a view's definition without the values written into it, and the tables it reads", () => {
    const view = rel("public.acme_notes");
    expect(view.kind).toBe("view");
    expect(view.build?.reads).toEqual([{ schema: "public", name: "notes" }]);
    expect(view.build?.definition).toMatch(/notes/);
    expect(view.build?.definition).not.toMatch(/secret-plan-name|alice|example\.com/);
    // A table says nothing of how it's built here: Postgres has no engines.
    expect(rel("public.accounts").build).toBeUndefined();
  });

  it("stops at the limit and says so", async () => {
    const small = await readCatalog(session.sql, { maxRelations: 3 });
    expect(small.relations).toHaveLength(3);
    expect(small.truncated).toBe(true);
  });
});

describe("the statement check against the server", () => {
  it("refuses a function the database defines, and lets built-in ones run", async () => {
    const dialect = dialectFor("postgres");
    const context = { session: async () => session as never, params: [], timeoutMs: 5_000 };
    const refused = async (sql: string) => {
      const check = await dialect.validate(sql, context);
      if (!check.ok) throw new Error(`expected ${sql} to parse`);
      return dialect.refuseCalls?.(session as never, check.info);
    };
    expect(await refused("select * from peek_users()")).toMatch(/peek_users\(\) is defined in the database/);
    // Named exactly as the parser read it: a quoted name is another name than its lowercase.
    expect(await refused('select * from "PEEK"()')).toMatch(/PEEK\(\) is defined in the database/);
    expect(await refused("select 'a'::text ===> 1")).toMatch(/operator ===> is defined in the database/);
    // In a subquery comparison and an ordering too.
    expect(await refused("select 'a'::text ===> any (select 1)")).toMatch(/operator ===> is defined in the database/);
    expect(await refused("select 'a' as x order by 1 using ===>")).toMatch(/operator ===> is defined in the database/);
    expect(await refused("select 'fine'::text::mood")).toMatch(/the cast from text to mood is defined in the database/);
    // A column whose type's implicit cast calls one: the type isn't named, but the column is read.
    expect(await refused("select lower(f) as x from public.feelings")).toMatch(
      /the cast from feeling to text is defined in the database/,
    );
    expect(await refused("select count(*) from public.feelings")).toMatch(/the cast from feeling to text/);
    // A statement with no call at all, only a cast through one.
    expect(await refused("select f::text as x from public.feelings")).toMatch(/the cast from feeling to text/);
    expect(await refused("select l from public.levels order by l")).toMatch(/the comparison of level/);
    expect(await refused("select lower(r) as x from public.rows_cast r")).toMatch(/the cast from rows_cast to text/);
    expect(await refused("select * from peek_catalog()")).toMatch(/peek_catalog\(\) is defined in the database/);
    expect(await refused("select count(*) from public.pairs")).toMatch(/the cast from feeling to text/);
    expect(await refused("select count(*) from public.ranges")).toMatch(/type num_range is defined in the database/);
    // A named type is walked in full too: its field's domain checks run when the value is read in.
    expect(await refused("select '(x)'::wrap as w")).toMatch(/type checked_text is defined in the database/);
    // An equality the parser writes no operator for (case x when y) is asked about as =.
    const owner = new URL(ADMIN);
    owner.pathname = `/${database}`;
    const db = postgres(owner.toString(), { max: 1, onnotice: () => {} });
    try {
      await db.unsafe(`create type public.shade as enum ('dark');
        create table public.shades (id int, s public.shade);
        create function public.shade_eq(public.shade, public.shade) returns boolean language sql security definer
          as $$ select true $$;
        create operator public.= (leftarg = public.shade, rightarg = public.shade, function = public.shade_eq)`);
      expect(await refused("select case s when 'dark' then 1 end as x from public.shades")).toMatch(
        /operator = is defined in the database/,
      );
    } finally {
      await db.unsafe(`drop operator if exists public.= (public.shade, public.shade);
        drop function if exists public.shade_eq(public.shade, public.shade); drop table if exists public.shades;
        drop type if exists public.shade`);
      await db.end();
    }
    // A domain whose check calls one.
    expect(await refused("select 'x'::checked_text")).toMatch(/type checked_text is defined in the database/);
    // A built-in sampling method runs; one named with another schema doesn't.
    expect(await refused("select count(*) from public.accounts tablesample system (10)")).toBeNull();
    expect(
      (await dialect.validate("select count(*) from public.accounts tablesample public.sys (10)", context)).ok,
    ).toBe(false);
    // A schema that only looks like pg_catalog is refused before the server is asked.
    expect((await dialect.validate('select * from "PG_CATALOG".peek()', context)).ok).toBe(false);
    // An enum of the team's own is a type that only holds values: it may be cast to.
    expect(await refused("select count(*) from public.accounts where 'x' = 'x'")).toBeNull();
    expect(await refused("select count(*), max(created_at) from public.accounts")).toBeNull();
  });
});

describe("profileRelation", () => {
  it("uses the planner's statistics for analyzed tables", async () => {
    const p = await profileRelation(session.sql, rel("public.accounts"), catalog, options);
    expect(p.method).toBe("statistics");
    expect(p.rows).toBe(1901);
    expect(p.columns.id?.roles).toContain("key");
    expect(p.columns.currency?.roles).toContain("category");
    expect(p.columns.currency?.top?.[0]?.value).toBe("USD");
    expect(p.columns.created_at?.roles).toContain("time");
    expect(p.freshness?.column).toBe("created_at");
    expect(p.columns.billing_email).toMatchObject({ sensitivity: "pii", roles: ["personal_data"] });
    expect(p.columns.billing_email?.top).toBeUndefined();
    expect(p.columns.billing_email?.min).toBeUndefined();
  });

  it("finds personal data by name and by value, and never keeps its values", async () => {
    const p = await profileRelation(session.sql, rel("public.users"), catalog, options);
    for (const name of ["email", "full_name", "phone"]) {
      expect(p.columns[name]?.sensitivity).toBe("pii");
      expect(p.columns[name]?.top).toBeUndefined();
    }
    expect(p.columns.role?.sensitivity).toBe("none");
  });

  it("marks amounts in cents and declared joins", async () => {
    const p = await profileRelation(session.sql, rel("public.subscriptions"), catalog, options);
    expect(p.columns.amount_cents?.roles).toContain("amount_cents");
    expect(p.columns.account_id?.references).toMatchObject({ table: "accounts", column: "id", declared: true });
    expect(p.columns.status?.roles).toContain("category");
    const invoices = await profileRelation(session.sql, rel("billing.invoices"), catalog, options);
    expect(invoices.columns.total_cents?.roles).toContain("amount_cents");
  });

  it("samples a table that was never analyzed, and infers an undeclared join from overlapping values", async () => {
    const p = await profileRelation(session.sql, rel("public.notes"), catalog, options);
    expect(p.method).toBe("sample");
    expect(p.rows).toBe(400);
    expect(p.columns.account_id?.references).toMatchObject({ table: "accounts", column: "id", declared: false });
    expect(p.columns.account_id?.references?.overlap).toBeGreaterThanOrEqual(0.95);
    expect(p.columns.body?.roles).toContain("free_text");
  });

  it("treats tokens and passwords as secrets, by name and by what the values look like", async () => {
    const p = await profileRelation(session.sql, rel("public.integrations"), catalog, options);
    expect(p.columns.api_token).toMatchObject({ sensitivity: "secret" });
    expect(p.columns.api_token?.top).toBeUndefined();
    expect(p.columns.credentials).toMatchObject({
      sensitivity: "secret",
      sensitivityReason: "values look like keys or tokens",
    });
    expect(p.columns.credentials?.top).toBeUndefined();
    expect(p.columns.ref?.sensitivity).toBe("none"); // UUIDs are identifiers
  });

  it("keeps no values of free text", async () => {
    const p = await profileRelation(session.sql, rel("public.notes"), catalog, options);
    expect(p.columns.body?.top).toBeUndefined();
    expect(p.columns.body?.min).toBeUndefined();
  });

  it("doesn't read the latest value of a personal time column", async () => {
    const p = await profileRelation(session.sql, rel("public.people"), catalog, options);
    expect(p.columns.dob).toMatchObject({ sensitivity: "pii" });
    expect(p.columns.dob?.maxValue).toBeUndefined();
    expect(p.columns.dob?.min).toBeUndefined();
    expect(p.freshness?.column).toBe("joined_at");
  });
});

describe("sample data", () => {
  it("the connection check recognises the demo company's marker", async () => {
    const result = await probePostgres(
      { host: ADMIN.hostname, port: Number(ADMIN.port || 5432), database, user: reader, sslMode: "disable" },
      "reader",
      { edition: "community", connectTimeoutMs: 5_000, statementTimeoutMs: 10_000 },
    );
    expect(result.outcome).toBe("passed");
    expect(result.facts.sampleData).toBe(true);
  });
});

describe("the session", () => {
  it("can't write through the session", async () => {
    const error = await session.sql`insert into public.notes (id) values (99999)`.catch((e: { code?: string }) => e);
    expect((error as { code?: string }).code).toMatch(/25006|42501/);
  });
});

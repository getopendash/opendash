import path from "node:path";
import { parseArgs } from "node:util";
import { createClient } from "@clickhouse/client";
import mysql from "mysql2/promise";
import { loadRootEnv } from "../../../scripts/load-env.mjs";
import { parseAsOf } from "../src/commerce/calendar";
import { LUMEN_DATABASE, LUMEN_READER, seedDemoCommerce } from "../src/commerce/demo-postgres";
import { seedDemoPostgres } from "../src/saas/demo-postgres";
import { AS_OF, endOfDay, yesterdayEnd } from "../src/saas/model";
import { grantReaderClickHouse, seedSaasClickHouse } from "../src/saas/seed-clickhouse";
import { grantReaderMySql, seedSaasMySql } from "../src/saas/seed-mysql";

/**
 * `pnpm demo:seed`: creates (or refreshes) Acme, the sample company, as its own database with a read-only user, on the
 * server DATABASE_ADMIN_URL points at. It's a database like any customer's: connect it on Data → Connect source.
 *
 *   pnpm demo:seed [--current | --as-of YYYY-MM-DD] [--database opendash_demo] [--user opendash_demo_reader] [--password …]
 *   pnpm demo:seed --clickhouse [--user opendash_demo_reader] [--password …]
 *   pnpm demo:seed --mysql [--user opendash_demo_reader] [--password …]
 *   pnpm demo:seed --commerce [--as-of YYYY-MM-DD] [--database opendash_demo_lumen] [--user opendash_lumen_reader]
 *
 * Acme's data ends on October 7, 2026 (the benchmark's fixed end), unless --current ends it yesterday or --as-of gives
 * a day: a demo that should look up to date is refreshed with --current, which replaces what's there.
 *
 * With --commerce it's Lumen, the second sample company (a home-lighting brand: orders, returns, campaigns, stock), as
 * its own Postgres database, with data up to the end of yesterday (UTC) unless --as-of gives another end date.
 *
 * With --clickhouse it's the same company in ClickHouse (CLICKHOUSE_ADMIN_URL, by default the local opt-in server
 * from `pnpm clickhouse:up`), in the databases public, billing and support, with a readonly = 2 user. With --mysql
 * it's the same company in MySQL (MYSQL_ADMIN_URL, by default `pnpm mysql:up`'s), in the same three databases, with a
 * user that can only SELECT.
 *
 * The password defaults to "opendash-demo" on a local server only (like the dev roles); anywhere else pass one.
 */
loadRootEnv(path.resolve(import.meta.dirname, "../../.."));

const { values } = parseArgs({
  options: {
    database: { type: "string" },
    user: { type: "string" },
    password: { type: "string" },
    commerce: { type: "boolean", default: false },
    "as-of": { type: "string" },
    current: { type: "boolean", default: false },
    clickhouse: { type: "boolean", default: false },
    mysql: { type: "boolean", default: false },
  },
});

if (values.mysql) {
  values.user ??= "opendash_demo_reader";
  const url = new URL(process.env.MYSQL_ADMIN_URL || "mysql://root:opendash@127.0.0.1:3307");
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  const user = values.user as string;
  const password = values.password ?? (local ? "opendash-demo" : undefined);
  if (!password) throw new Error("Pass --password for the read-only user when the server isn't local.");
  const conn = await mysql.createConnection({ uri: url.toString() });
  const summary = await seedSaasMySql(conn);
  await grantReaderMySql(conn, { name: user, password });
  await conn.end();
  const rows = Object.values(summary.tables).reduce((a, b) => a + b, 0);
  console.info(`Seeded MySQL: ${Object.keys(summary.tables).length} tables, ${rows.toLocaleString("en-US")} rows.

Connect it on Data → Connect source → MySQL:
  Host      ${url.hostname}
  Port      ${url.port || "3306"}
  Database  public
  Username  ${user}
  Password  ${values.password ? "(the one you passed)" : password}
  SSL mode  disable`);
  process.exit(0);
}

if (values.clickhouse) {
  values.user ??= "opendash_demo_reader";
  const url = new URL(process.env.CLICKHOUSE_ADMIN_URL ?? "http://opendash_owner:opendash@127.0.0.1:8124");
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  const user = values.user as string;
  const password = values.password ?? (local ? "opendash-demo" : undefined);
  if (!password) throw new Error("Pass --password for the read-only user when the server isn't local.");
  const client = createClient({
    url: `${url.protocol}//${url.host}`,
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  });
  const summary = await seedSaasClickHouse(client);
  await grantReaderClickHouse(client, { name: user, password });
  await client.close();
  const rows = Object.values(summary.tables).reduce((a, b) => a + b, 0);
  console.info(`Seeded ClickHouse: ${Object.keys(summary.tables).length} tables, ${rows.toLocaleString("en-US")} rows.

Connect it on Data → Connect source → ClickHouse:
  Host      ${url.hostname}
  Port      ${url.port || (url.protocol === "https:" ? "8443" : "8123")}
  Database  public
  Username  ${user}
  Password  ${values.password ? "(the one you passed)" : password}
  SSL mode  ${url.protocol === "https:" ? "verify-full" : "disable"}`);
  process.exit(0);
}
const adminUrl = process.env.DATABASE_ADMIN_URL;
if (!adminUrl) throw new Error("Set DATABASE_ADMIN_URL (an admin on the Postgres server to create the demo on).");
const admin = new URL(adminUrl);
const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(admin.hostname);
const database = values.database ?? (values.commerce ? LUMEN_DATABASE : "opendash_demo");
const reader = values.user ?? (values.commerce ? LUMEN_READER : "opendash_demo_reader");
const password = values.password ?? (local ? "opendash-demo" : undefined);
if (!password) throw new Error("Pass --password for the read-only user when the server isn't local.");

// Acme: the benchmark's fixed end unless asked for yesterday or a day (the end of that day, 23:00 UTC).
const acmeEnd = values.current
  ? yesterdayEnd()
  : values["as-of"] && !values.commerce
    ? Math.max(AS_OF, endOfDay(new Date(`${values["as-of"]}T12:00:00Z`)))
    : undefined;
if (acmeEnd !== undefined && Number.isNaN(acmeEnd)) throw new Error("Use a date as YYYY-MM-DD.");

const seeded = values.commerce
  ? await seedDemoCommerce(adminUrl, {
      database,
      reader,
      password,
      ...(values["as-of"] ? { asOf: parseAsOf(values["as-of"]) } : {}),
    })
  : await seedDemoPostgres(adminUrl, {
      database,
      reader,
      password,
      ...(acmeEnd === undefined ? {} : { asOf: acmeEnd }),
    });
const { tables, rows } = seeded.seeded ? seeded : { tables: 0, rows: 0 };
const endOfData = values.commerce ? (seeded as { asOf?: number }).asOf : (acmeEnd ?? AS_OF);
const through = endOfData ? ` (data to ${new Date(endOfData).toISOString().slice(0, 10)})` : "";
console.info(`Seeded ${database}${through}: ${tables} tables, ${rows.toLocaleString("en-US")} rows.

Connect it on Data → Connect source → PostgreSQL:
  Host      ${admin.hostname}
  Port      ${admin.port || "5432"}
  Database  ${database}
  Username  ${reader}
  Password  ${values.password ? "(the one you passed)" : password}
  SSL mode  ${local ? "disable" : "require"}`);

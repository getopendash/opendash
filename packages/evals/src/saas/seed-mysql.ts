/**
 * The demo company in MySQL: the same rows as the Postgres seed (demoRows), in three databases that mirror its
 * schemas (public, billing, support), with the same keys and foreign keys. A prefix keeps parallel test runs apart;
 * `pnpm demo:seed --mysql` uses none. MySQL databases take no comment, so the sample-data marker is the comment of
 * the public database's `plans` table, which the connection check reads. Times are UTC DATETIME(3).
 */
import type { Connection } from "mysql2/promise";
import { demoRows, SAMPLE_DATA_MARKER } from "./seed";

const DT = "datetime(3)";
const TEXT = "varchar(255)";

/** Columns per table in the order the rows have them, plus keys; foreign keys name `schema.table(column)`. */
const TABLES: Record<string, { columns: [string, string][]; key: string[]; refs?: [string, string][] }> = {
  "public.plans": {
    key: ["id"],
    columns: [
      ["id", "varchar(64) not null"],
      ["name", `${TEXT} not null`],
      ["unit_amount_cents", "int not null comment 'Monthly list price per unit, in cents'"],
      ["per_seat", "boolean not null"],
      ["min_seats", "int not null"],
    ],
  },
  "public.accounts": {
    key: ["id"],
    columns: [
      ["id", "bigint not null"],
      ["name", `${TEXT} not null`],
      ["domain", `${TEXT} not null`],
      ["country", "char(2) not null"],
      ["currency", "char(3) not null"],
      ["industry", TEXT],
      ["employee_band", TEXT],
      ["is_test", "boolean not null default false"],
      ["billing_email", TEXT],
      ["created_at", `${DT} not null`],
    ],
  },
  "public.users": {
    key: ["id"],
    refs: [["account_id", "public.accounts(id)"]],
    columns: [
      ["id", "bigint not null"],
      ["account_id", "bigint not null"],
      ["full_name", `${TEXT} not null`],
      ["email", `${TEXT} not null`],
      ["phone", TEXT],
      ["role", `${TEXT} not null`],
      ["created_at", `${DT} not null`],
      ["last_seen_at", DT],
    ],
  },
  "public.subscriptions": {
    key: ["id"],
    refs: [
      ["account_id", "public.accounts(id)"],
      ["plan_id", "public.plans(id)"],
    ],
    columns: [
      ["id", "bigint not null"],
      ["account_id", "bigint not null"],
      ["plan_id", "varchar(64) not null"],
      ["status", `${TEXT} not null`],
      ["currency", "char(3) not null"],
      ["billing_interval", `${TEXT} not null`],
      ["seats", "int not null"],
      ["amount_cents", "int not null comment 'List price per billing interval, in cents (set during trials too)'"],
      ["discount_pct", "int not null default 0"],
      ["started_at", `${DT} not null`],
      ["trial_ends_at", DT],
      ["canceled_at", DT],
      ["cancel_reason", TEXT],
      ["paused_at", DT],
      ["resumed_at", DT],
    ],
  },
  "public.subscription_items": {
    key: ["id"],
    refs: [
      ["subscription_id", "public.subscriptions(id)"],
      ["plan_id", "public.plans(id)"],
    ],
    columns: [
      ["id", "bigint not null"],
      ["subscription_id", "bigint not null"],
      ["plan_id", "varchar(64) not null"],
      ["quantity", "int not null"],
      ["unit_amount_cents", "int not null"],
      ["started_at", `${DT} not null`],
      ["ended_at", DT],
    ],
  },
  "billing.fx_rates": {
    key: ["rate_date", "currency"],
    columns: [
      ["rate_date", "date not null"],
      ["currency", "char(3) not null"],
      ["rate_to_usd", "decimal(10, 4) not null"],
    ],
  },
  "billing.invoices": {
    key: ["id"],
    refs: [
      ["account_id", "public.accounts(id)"],
      ["subscription_id", "public.subscriptions(id)"],
    ],
    columns: [
      ["id", "bigint not null"],
      ["number", "varchar(64) not null unique"],
      ["account_id", "bigint not null"],
      ["subscription_id", "bigint"],
      ["currency", "char(3) not null"],
      ["issued_at", `${DT} not null`],
      ["period_start", `${DT} not null`],
      ["period_end", `${DT} not null`],
      ["subtotal_cents", "bigint not null"],
      ["discount_cents", "bigint not null"],
      ["tax_cents", "bigint not null"],
      ["total_cents", "bigint not null comment 'In the invoice currency, including tax'"],
      ["status", `${TEXT} not null`],
    ],
  },
  "billing.invoice_lines": {
    key: ["id"],
    refs: [
      ["invoice_id", "billing.invoices(id)"],
      ["plan_id", "public.plans(id)"],
    ],
    columns: [
      ["id", "bigint not null"],
      ["invoice_id", "bigint not null"],
      ["kind", `${TEXT} not null`],
      ["plan_id", "varchar(64)"],
      ["quantity", "int not null"],
      ["amount_cents", "bigint not null"],
      ["description", TEXT],
    ],
  },
  "billing.payments": {
    key: ["id"],
    refs: [["invoice_id", "billing.invoices(id)"]],
    columns: [
      ["id", "bigint not null"],
      ["invoice_id", "bigint not null"],
      ["amount_cents", "bigint not null"],
      ["currency", "char(3) not null"],
      ["status", `${TEXT} not null`],
      ["method", `${TEXT} not null`],
      ["created_at", `${DT} not null`],
    ],
  },
  "billing.refunds": {
    key: ["id"],
    refs: [["payment_id", "billing.payments(id)"]],
    columns: [
      ["id", "bigint not null"],
      ["payment_id", "bigint not null"],
      ["amount_cents", "bigint not null"],
      ["reason", TEXT],
      ["created_at", `${DT} not null`],
    ],
  },
  "billing.credits": {
    key: ["id"],
    refs: [["account_id", "public.accounts(id)"]],
    columns: [
      ["id", "bigint not null"],
      ["account_id", "bigint not null"],
      ["amount_cents", "bigint not null"],
      ["currency", "char(3) not null"],
      ["reason", TEXT],
      ["created_at", `${DT} not null`],
    ],
  },
  "support.tickets": {
    key: ["id"],
    refs: [
      ["account_id", "public.accounts(id)"],
      ["user_id", "public.users(id)"],
    ],
    columns: [
      ["id", "bigint not null"],
      ["account_id", "bigint not null"],
      ["user_id", "bigint"],
      ["subject", `${TEXT} not null`],
      ["priority", `${TEXT} not null`],
      ["status", `${TEXT} not null`],
      ["channel", `${TEXT} not null`],
      ["created_at", `${DT} not null`],
      ["solved_at", DT],
      ["csat", "smallint"],
    ],
  },
};

const q = (name: string) => `\`${name.replaceAll("`", "``")}\``;
const literal = (s: string) => `'${s.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;

/** The three databases for a prefix: public, billing, support. */
export const mysqlDatabases = (prefix = "") => ["public", "billing", "support"].map((d) => `${prefix}${d}`);

/** A value as MySQL stores it: times as UTC 'YYYY-MM-DD HH:MM:SS.sss', booleans as 1/0. */
function value(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().replace("T", " ").replace("Z", "");
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(v)) {
    return v.replace("T", " ").replace("Z", "");
  }
  if (typeof v === "boolean") return v ? 1 : 0;
  return v;
}

export async function seedSaasMySql(
  conn: Connection,
  options: { prefix?: string; seed?: number } = {},
): Promise<{ tables: Record<string, number> }> {
  const prefix = options.prefix ?? "";
  await conn.query("set foreign_key_checks = 0");
  for (const db of mysqlDatabases(prefix)) await conn.query(`drop database if exists ${q(db)}`);
  for (const db of mysqlDatabases(prefix)) await conn.query(`create database ${q(db)} character set utf8mb4`);
  const tables: Record<string, number> = {};
  for (const [name, rows] of demoRows(options.seed)) {
    const spec = TABLES[name];
    if (!spec) throw new Error(`No MySQL definition for ${name}`);
    const [schema, table] = name.split(".") as [string, string];
    const target = `${q(prefix + schema)}.${q(table)}`;
    const refs = (spec.refs ?? []).map(([column, ref]) => {
      const m = /^(\w+)\.(\w+)\((\w+)\)$/.exec(ref) as RegExpExecArray;
      return `foreign key (${q(column)}) references ${q(prefix + m[1])}.${q(m[2] as string)} (${q(m[3] as string)})`;
    });
    const comment = name === "public.plans" ? ` comment = ${literal(SAMPLE_DATA_MARKER)}` : "";
    await conn.query(
      `create table ${target} (${[
        ...spec.columns.map(([c, t]) => `${q(c)} ${t}`),
        `primary key (${spec.key.map(q).join(", ")})`,
        ...refs,
      ].join(", ")})${comment}`,
    );
    const columns = spec.columns.map(([c]) => c);
    for (let i = 0; i < rows.length; i += 1_000) {
      const batch = rows.slice(i, i + 1_000).map((r) => columns.map((c) => value(r[c])));
      await conn.query(`insert into ${target} (${columns.map(q).join(", ")}) values ?`, [batch]);
    }
    tables[name] = rows.length;
  }
  await conn.query("set foreign_key_checks = 1");
  // Row estimates for the catalog, as a database that's been running would have them.
  for (const name of Object.keys(TABLES)) {
    const [schema, table] = name.split(".") as [string, string];
    await conn.query(`analyze table ${q(prefix + schema)}.${q(table)}`);
  }
  return { tables };
}

/** A login user that can read every demo table and nothing else (SELECT on the three databases). */
export async function grantReaderMySql(conn: Connection, user: { name: string; password: string }, prefix = "") {
  await conn.query(`drop user if exists ${literal(user.name)}@'%'`);
  await conn.query(`create user ${literal(user.name)}@'%' identified by ${literal(user.password)}`);
  for (const db of mysqlDatabases(prefix)) await conn.query(`grant select on ${q(db)}.* to ${literal(user.name)}@'%'`);
}

/**
 * The demo company in ClickHouse: the same rows as the Postgres seed (demoRows), in three databases that mirror its
 * schemas (public, billing, support), each table a MergeTree ordered by its key. A prefix keeps parallel test runs
 * apart; `pnpm demo:seed --clickhouse` uses none. The public database carries the sample-data marker as its comment,
 * which the connection check reads.
 *
 * Support tickets are kept the way warehouses often keep a table they're sent changes of: a
 * ReplacingMergeTree, where a ticket solved since it was opened still has its earlier, open version until parts merge.
 * Merges are stopped on it, so that version stays: counted without FINAL, a solved ticket counts twice. With FINAL
 * (the last version inserted wins) the table reads as the Postgres one does.
 */
import type { ClickHouseClient } from "@clickhouse/client";
import { demoRows, SAMPLE_DATA_MARKER } from "./seed";

const DT = "DateTime64(3, 'UTC')";
const N = (t: string) => `Nullable(${t})`;
const LC = "LowCardinality(String)";

type Row = Record<string, unknown>;

/**
 * Column types per table, in the order the rows have them; `order` is the MergeTree key. `earlier` gives a table kept
 * as a ReplacingMergeTree the versions its rows replaced, inserted first.
 */
const TABLES: Record<
  string,
  { columns: [string, string, string?][]; order: string; earlier?: (rows: Row[]) => Row[] }
> = {
  "public.plans": {
    order: "id",
    columns: [
      ["id", "String"],
      ["name", "String"],
      ["unit_amount_cents", "Int32", "Monthly list price per unit, in cents"],
      ["per_seat", "Bool"],
      ["min_seats", "Int32"],
    ],
  },
  "public.accounts": {
    order: "id",
    columns: [
      ["id", "Int64"],
      ["name", "String"],
      ["domain", "String"],
      ["country", LC],
      ["currency", LC],
      ["industry", N("String")],
      ["employee_band", N("String")],
      ["is_test", "Bool"],
      ["billing_email", N("String")],
      ["created_at", DT],
    ],
  },
  "public.users": {
    order: "id",
    columns: [
      ["id", "Int64"],
      ["account_id", "Int64"],
      ["full_name", "String"],
      ["email", "String"],
      ["phone", N("String")],
      ["role", LC],
      ["created_at", DT],
      ["last_seen_at", N(DT)],
    ],
  },
  "public.subscriptions": {
    order: "id",
    columns: [
      ["id", "Int64"],
      ["account_id", "Int64"],
      ["plan_id", "String"],
      ["status", LC],
      ["currency", LC],
      ["billing_interval", LC],
      ["seats", "Int32"],
      ["amount_cents", "Int32", "List price per billing interval, in cents (set during trials too)"],
      ["discount_pct", "Int32"],
      ["started_at", DT],
      ["trial_ends_at", N(DT)],
      ["canceled_at", N(DT)],
      ["cancel_reason", N("String")],
      ["paused_at", N(DT)],
      ["resumed_at", N(DT)],
    ],
  },
  "public.subscription_items": {
    order: "id",
    columns: [
      ["id", "Int64"],
      ["subscription_id", "Int64"],
      ["plan_id", "String"],
      ["quantity", "Int32"],
      ["unit_amount_cents", "Int32"],
      ["started_at", DT],
      ["ended_at", N(DT)],
    ],
  },
  "billing.fx_rates": {
    order: "(rate_date, currency)",
    columns: [
      ["rate_date", "Date"],
      ["currency", LC],
      ["rate_to_usd", "Decimal(10, 4)"],
    ],
  },
  "billing.invoices": {
    order: "id",
    columns: [
      ["id", "Int64"],
      ["number", "String"],
      ["account_id", "Int64"],
      ["subscription_id", N("Int64")],
      ["currency", LC],
      ["issued_at", DT],
      ["period_start", DT],
      ["period_end", DT],
      ["subtotal_cents", "Int64"],
      ["discount_cents", "Int64"],
      ["tax_cents", "Int64"],
      ["total_cents", "Int64", "In the invoice currency, including tax"],
      ["status", LC],
    ],
  },
  "billing.invoice_lines": {
    order: "id",
    columns: [
      ["id", "Int64"],
      ["invoice_id", "Int64"],
      ["kind", LC],
      ["plan_id", N("String")],
      ["quantity", "Int32"],
      ["amount_cents", "Int64"],
      ["description", N("String")],
    ],
  },
  "billing.payments": {
    order: "id",
    columns: [
      ["id", "Int64"],
      ["invoice_id", "Int64"],
      ["amount_cents", "Int64"],
      ["currency", LC],
      ["status", LC],
      ["method", LC],
      ["created_at", DT],
    ],
  },
  "billing.refunds": {
    order: "id",
    columns: [
      ["id", "Int64"],
      ["payment_id", "Int64"],
      ["amount_cents", "Int64"],
      ["reason", N("String")],
      ["created_at", DT],
    ],
  },
  "billing.credits": {
    order: "id",
    columns: [
      ["id", "Int64"],
      ["account_id", "Int64"],
      ["amount_cents", "Int64"],
      ["currency", LC],
      ["reason", N("String")],
      ["created_at", DT],
    ],
  },
  "support.tickets": {
    order: "id",
    // Solved since: it was open before.
    earlier: (rows) =>
      rows.filter((r) => r.status === "solved").map((r) => ({ ...r, status: "open", solved_at: null, csat: null })),
    columns: [
      ["id", "Int64"],
      ["account_id", "Int64"],
      ["user_id", N("Int64")],
      ["subject", "String"],
      ["priority", LC],
      ["status", LC],
      ["channel", LC],
      ["created_at", DT],
      ["solved_at", N(DT)],
      ["csat", N("Int16")],
    ],
  },
};

const literal = (s: string) => `'${s.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;

/** The three databases for a prefix: public, billing, support. */
export const clickhouseDatabases = (prefix = "") => ["public", "billing", "support"].map((d) => `${prefix}${d}`);

export async function seedSaasClickHouse(
  client: ClickHouseClient,
  options: { prefix?: string; seed?: number } = {},
): Promise<{ tables: Record<string, number> }> {
  const prefix = options.prefix ?? "";
  for (const db of clickhouseDatabases(prefix)) await client.command({ query: `drop database if exists \`${db}\`` });
  for (const db of clickhouseDatabases(prefix)) {
    const comment = db === `${prefix}public` ? ` comment ${literal(SAMPLE_DATA_MARKER)}` : "";
    await client.command({ query: `create database \`${db}\`${comment}` });
  }
  const tables: Record<string, number> = {};
  for (const [name, rows] of demoRows(options.seed)) {
    const spec = TABLES[name];
    if (!spec) throw new Error(`No ClickHouse definition for ${name}`);
    const [schema, table] = name.split(".") as [string, string];
    const target = `\`${prefix}${schema}\`.\`${table}\``;
    const columns = spec.columns
      .map(([c, t, comment]) => `\`${c}\` ${t}${comment ? ` comment ${literal(comment)}` : ""}`)
      .join(", ");
    const engine = spec.earlier ? "ReplacingMergeTree" : "MergeTree";
    await client.command({ query: `create table ${target} (${columns}) engine = ${engine} order by ${spec.order}` });
    // Earlier versions first, in their own part, and no merge to fold them away.
    if (spec.earlier) await client.command({ query: `system stop merges ${target}` });
    for (const values of spec.earlier ? [spec.earlier(rows as Row[]), rows] : [rows]) {
      if (!values.length) continue;
      await client.insert({
        table: target,
        values,
        format: "JSONEachRow",
        clickhouse_settings: { date_time_input_format: "best_effort" },
      });
    }
    tables[name] = rows.length;
  }
  return { tables };
}

/**
 * A login user that can read every demo table and nothing else. Its profile has readonly = 2: it can't write tables
 * whatever it's granted, and can still take the per-query limits OpenDash sets.
 */
export async function grantReaderClickHouse(
  client: ClickHouseClient,
  user: { name: string; password: string },
  prefix = "",
) {
  await client.command({ query: `drop user if exists \`${user.name}\`` });
  await client.command({
    query: `create user \`${user.name}\` identified with sha256_password by ${literal(user.password)} settings readonly = 2`,
  });
  for (const db of clickhouseDatabases(prefix)) {
    await client.command({ query: `grant select on \`${db}\`.* to \`${user.name}\`` });
  }
}

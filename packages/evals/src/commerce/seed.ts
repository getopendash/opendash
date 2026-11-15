/**
 * Writes Lumen into a Postgres database: schemas shop (customers, products, orders, payments, shipments, returns,
 * refunds, gift cards, discounts, fx_rates), marketing (campaigns, ad_spend_daily, daily_sessions), inventory
 * (warehouses, stock_snapshots, purchase_orders, stockout_days) and support (tickets). Re-running replaces the data, so
 * the result is the same every time for the same seed and end date.
 */
import type postgres from "postgres";
import { defaultAsOf, ymd } from "./calendar";
import { DEFAULT_SEED, generateLumen } from "./model";
import type { LumenCompany } from "./types";

type Sql = postgres.Sql;

/** The database comment that marks OpenDash sample data (the connection check matches its "opendash:sample-data" prefix). */
export const LUMEN_DATA_MARKER = "opendash:sample-data lumen v1";

const DDL = `
drop schema if exists shop cascade;
drop schema if exists marketing cascade;
drop schema if exists inventory cascade;
drop schema if exists support cascade;
create schema shop;
create schema marketing;
create schema inventory;
create schema support;

create table shop.fx_rates (
  rate_date date not null,
  currency char(3) not null,
  rate_to_usd numeric(8, 4) not null,
  primary key (rate_date, currency)
);
comment on table shop.fx_rates is 'Daily rates: one unit of the currency in US dollars. The store reports in USD.';

create table shop.customers (
  id bigint primary key,
  email text not null,
  first_name text,
  last_name text,
  country char(2) not null,
  is_guest boolean not null,
  is_wholesale boolean not null default false,
  company_name text,
  marketing_opt_in boolean not null,
  acquisition_channel text,
  created_at timestamptz not null
);
comment on column shop.customers.is_guest is 'A guest checkout row. The same person can have a guest row and an account row, with the email in another case.';

create table shop.addresses (
  id bigint primary key,
  customer_id bigint not null references shop.customers (id),
  country char(2) not null,
  region text,
  postal_code text not null,
  city text not null,
  is_default boolean not null
);

create table shop.products (
  id bigint primary key,
  name text not null,
  product_line text not null,
  category text not null,
  status text not null,
  created_at timestamptz not null,
  deleted_at timestamptz
);
comment on column shop.products.deleted_at is 'Soft delete: a discontinued product keeps its orders.';

create table shop.variants (
  id bigint primary key,
  product_id bigint not null references shop.products (id),
  sku text not null,
  option_name text not null,
  price_usd_cents integer not null,
  unit_cost_cents integer not null,
  weight_g integer not null,
  is_active boolean not null,
  previous_sku text,
  sku_changed_at timestamptz
);
comment on column shop.variants.price_usd_cents is 'The current US list price, in cents. Prices have changed: order lines carry the price paid.';
comment on column shop.variants.previous_sku is 'The SKU before it was changed. Order lines keep the SKU of their day: group by variant_id.';

create table shop.bundles (
  id bigint primary key,
  name text not null,
  sku text not null,
  price_usd_cents integer not null
);
create table shop.bundle_items (
  bundle_id bigint not null references shop.bundles (id),
  variant_id bigint not null references shop.variants (id),
  quantity integer not null,
  primary key (bundle_id, variant_id)
);

create table shop.discounts (
  id bigint primary key,
  code text not null,
  kind text not null,
  percent_off integer not null
);

create table shop.orders (
  id bigint primary key,
  number text not null,
  customer_id bigint not null references shop.customers (id),
  order_type text not null,
  is_test boolean not null,
  placed_at timestamptz not null,
  currency char(3) not null,
  ship_country char(2) not null,
  ship_region text,
  status text not null,
  cancel_reason text,
  source_channel text,
  campaign_id bigint,
  device text,
  subtotal_cents bigint not null,
  discount_cents bigint not null,
  shipping_cents bigint not null,
  tax_cents bigint not null,
  tax_rate_bps integer not null,
  tax_inclusive boolean not null,
  gift_card_cents bigint not null,
  total_cents bigint not null
);
comment on table shop.orders is 'Every order in its own currency, in cents. Retail and wholesale (order_type) and internal test orders (is_test) are in one table.';
comment on column shop.orders.placed_at is 'UTC. The store reports in America/New_York.';
comment on column shop.orders.status is 'processing, shipped (the old spelling of fulfilled, before 2025-04-15), fulfilled, canceled (before 2025-06-01) or cancelled.';
comment on column shop.orders.subtotal_cents is 'Item, bundle and gift card lines, before discounts. Component lines are not in it.';
comment on column shop.orders.discount_cents is 'Merchandise discounts only. A free-shipping code is a row in order_discounts with applies_to = shipping.';
comment on column shop.orders.shipping_cents is 'Charged shipping. Prices include VAT where tax_inclusive (UK and EU) and exclude sales tax elsewhere.';
comment on column shop.orders.tax_cents is 'The tax in the total: contained in it where tax_inclusive, added on top where not.';
comment on column shop.orders.total_cents is 'subtotal - discount + shipping, plus tax where the prices exclude it. Gift card tender is part of it, not off it.';
comment on column shop.orders.gift_card_cents is 'Paid by gift card: a tender, not a discount.';

create table shop.order_lines (
  id bigint primary key,
  order_id bigint not null references shop.orders (id),
  line_kind text not null,
  parent_line_id bigint references shop.order_lines (id),
  variant_id bigint references shop.variants (id),
  bundle_id bigint references shop.bundles (id),
  sku text not null,
  description text not null,
  quantity integer not null,
  unit_price_cents bigint not null,
  line_total_cents bigint not null,
  discount_cents bigint not null
);
comment on column shop.order_lines.line_kind is 'item, bundle, component (a bundle''s parts, priced at their share of it: counting every line counts the bundle twice) or gift_card.';
comment on column shop.order_lines.discount_cents is 'This line''s share of the order''s merchandise discount.';

create table shop.order_discounts (
  order_id bigint not null references shop.orders (id),
  discount_id bigint not null references shop.discounts (id),
  applies_to text not null,
  amount_cents bigint not null,
  primary key (order_id, discount_id)
);

create table shop.gift_cards (
  id bigint primary key,
  code text not null,
  currency char(3) not null,
  initial_cents bigint not null,
  issued_at timestamptz not null,
  purchase_order_id bigint not null references shop.orders (id)
);
create table shop.gift_card_redemptions (
  id bigint primary key,
  gift_card_id bigint not null references shop.gift_cards (id),
  order_id bigint not null references shop.orders (id),
  amount_cents bigint not null,
  redeemed_at timestamptz not null
);

create table shop.payments (
  id bigint primary key,
  order_id bigint not null references shop.orders (id),
  method text not null,
  status text not null,
  amount_cents bigint not null,
  currency char(3) not null,
  created_at timestamptz not null
);
comment on column shop.payments.method is 'card, paypal, apple_pay, klarna, gift_card (a tender), invoice (wholesale, net 30) or test.';

create table shop.shipments (
  id bigint primary key,
  order_id bigint not null references shop.orders (id),
  warehouse_id bigint not null,
  carrier text not null,
  tracking_number text not null,
  status text not null,
  shipped_at timestamptz not null,
  delivered_at timestamptz
);

create table shop.returns (
  id bigint primary key,
  order_id bigint not null references shop.orders (id),
  status text not null,
  reason text not null,
  requested_at timestamptz not null,
  received_at timestamptz
);
create table shop.return_lines (
  id bigint primary key,
  return_id bigint not null references shop.returns (id),
  order_line_id bigint not null references shop.order_lines (id),
  quantity integer not null
);
create table shop.refunds (
  id bigint primary key,
  order_id bigint not null references shop.orders (id),
  return_id bigint references shop.returns (id),
  reason text not null,
  amount_cents bigint not null,
  merchandise_cents bigint not null,
  shipping_cents bigint not null,
  tax_cents bigint not null,
  currency char(3) not null,
  created_at timestamptz not null
);
comment on column shop.refunds.amount_cents is 'What went back to the customer: merchandise + shipping, plus tax where the prices exclude it.';
comment on column shop.refunds.merchandise_cents is 'The merchandise part, as the order shows it (with VAT where tax_inclusive).';

create table marketing.campaigns (
  id bigint primary key,
  name text not null,
  channel text not null,
  platform text,
  objective text not null,
  is_commission boolean not null,
  start_date date not null,
  end_date date
);
comment on column marketing.campaigns.is_commission is 'Paid by commission on sales: there are no spend rows.';
create table marketing.ad_spend_daily (
  campaign_id bigint not null references marketing.campaigns (id),
  spend_date date not null,
  spend_cents bigint not null,
  impressions bigint not null,
  clicks bigint not null,
  platform_conversions integer not null,
  platform_revenue_cents bigint not null,
  primary key (campaign_id, spend_date)
);
comment on column marketing.ad_spend_daily.spend_cents is 'US dollars, in cents.';
comment on column marketing.ad_spend_daily.platform_revenue_cents is 'What the ad platform claims, in USD cents: more than the store counts, and not net of returns.';
create table marketing.daily_sessions (
  session_date date not null,
  channel text not null,
  country char(2) not null,
  device text not null,
  sessions integer not null,
  primary key (session_date, channel, country, device)
);
comment on column marketing.daily_sessions.session_date is 'A New York day, like the store''s reports; orders.placed_at is UTC.';

create table inventory.warehouses (
  id bigint primary key,
  code text not null,
  name text not null,
  region text not null
);
create table inventory.stock_snapshots (
  snapshot_date date not null,
  warehouse_id bigint not null references inventory.warehouses (id),
  variant_id bigint not null references shop.variants (id),
  on_hand_units integer not null,
  primary key (snapshot_date, warehouse_id, variant_id)
);
create table inventory.purchase_orders (
  id bigint primary key,
  warehouse_id bigint not null references inventory.warehouses (id),
  variant_id bigint not null references shop.variants (id),
  ordered_at timestamptz not null,
  expected_at date not null,
  received_at timestamptz,
  quantity integer not null,
  unit_cost_cents integer not null,
  delay_reason text
);
create table inventory.stockout_days (
  warehouse_id bigint not null references inventory.warehouses (id),
  variant_id bigint not null references shop.variants (id),
  stockout_date date not null,
  primary key (warehouse_id, variant_id, stockout_date)
);

create table support.tickets (
  id bigint primary key,
  customer_id bigint not null references shop.customers (id),
  order_id bigint references shop.orders (id),
  country char(2) not null,
  category text not null,
  channel text not null,
  priority text not null,
  status text not null,
  created_at timestamptz not null,
  first_response_at timestamptz,
  solved_at timestamptz,
  csat integer
);

create index on shop.customers (lower(email));
create index on shop.orders (customer_id);
create index on shop.orders (placed_at);
create index on shop.order_lines (order_id);
create index on shop.payments (order_id);
create index on shop.shipments (order_id);
create index on shop.returns (order_id);
create index on shop.refunds (order_id);
create index on shop.refunds (created_at);
create index on marketing.ad_spend_daily (spend_date);
create index on support.tickets (order_id);
create index on support.tickets (created_at);
`;

/** A model value as the database takes it: `_at` fields are instants, `_date` fields are dates. */
const dbValue = (key: string, value: unknown) => {
  if (value === null || value === undefined) return null;
  if (key.endsWith("_at") && typeof value === "number") return new Date(value);
  if (key.endsWith("_date") && typeof value === "number") return ymd(value);
  return value;
};

async function insert(sql: Sql, table: string, rows: object[]) {
  if (!rows.length) return;
  const columns = Object.keys(rows[0] as object);
  const batch = Math.max(1, Math.floor(30_000 / columns.length));
  for (let i = 0; i < rows.length; i += batch) {
    const slice = rows.slice(i, i + batch).map((row) => {
      const out: Record<string, unknown> = {};
      for (const c of columns) out[c] = dbValue(c, (row as Record<string, unknown>)[c]);
      return out;
    });
    await sql`insert into ${sql.unsafe(table)} ${sql(slice as never, columns)}`;
  }
}

export interface LumenSeedSummary {
  tables: Record<string, number>;
  /** The end of the data. */
  asOf: number;
}

export interface LumenOptions {
  seed?: number;
  /** The end of the data (an instant): by default the end of yesterday, UTC. */
  asOf?: number;
}

/** Every Lumen table's rows, keyed by schema.table, in the order they load. */
export function lumenRows(company: LumenCompany): [string, object[]][] {
  return [
    ["shop.fx_rates", company.fx],
    ["shop.customers", company.customers],
    ["shop.addresses", company.addresses],
    ["shop.products", company.products],
    ["shop.variants", company.variants],
    ["shop.bundles", company.bundles],
    ["shop.bundle_items", company.bundleItems],
    ["shop.discounts", company.discounts],
    ["shop.orders", company.orders],
    ["shop.order_lines", company.lines],
    ["shop.order_discounts", company.orderDiscounts],
    ["shop.gift_cards", company.giftCards],
    ["shop.gift_card_redemptions", company.redemptions],
    ["shop.payments", company.payments],
    ["shop.shipments", company.shipments],
    ["shop.returns", company.returns],
    ["shop.return_lines", company.returnLines],
    ["shop.refunds", company.refunds],
    ["marketing.campaigns", company.campaigns],
    ["marketing.ad_spend_daily", company.adSpend],
    ["marketing.daily_sessions", company.sessions],
    ["inventory.warehouses", company.warehouses],
    ["inventory.stock_snapshots", company.stock],
    ["inventory.purchase_orders", company.purchaseOrders],
    ["inventory.stockout_days", company.stockouts],
    ["support.tickets", company.tickets],
  ];
}

/** Creates the schemas and tables and loads the data. The caller's role owns the tables. */
export async function seedLumen(sql: Sql, options: LumenOptions = {}): Promise<LumenSeedSummary> {
  const asOf = options.asOf ?? defaultAsOf();
  const company = generateLumen(options.seed ?? DEFAULT_SEED, asOf);
  await sql.unsafe(DDL);
  const summary: LumenSeedSummary = { tables: {}, asOf };
  for (const [table, rows] of lumenRows(company)) {
    await insert(sql, table, rows);
    summary.tables[table] = rows.length;
  }
  // Statistics, as any long-running database has them: profiling reads pg_stats before sampling.
  await sql.unsafe("analyze");
  // Marks the database as OpenDash's sample data (the connection check reads this comment).
  await sql.unsafe(
    `do $$ begin execute format('comment on database %I is %L', current_database(), '${LUMEN_DATA_MARKER} (data to ${ymd(asOf)})'); end $$`,
  );
  return summary;
}

/** Lets a login role read every Lumen table, now and after a re-seed. */
export async function grantLumenReader(sql: Sql, role: string) {
  const r = `"${role.replaceAll('"', '""')}"`;
  await sql.unsafe(`
    grant usage on schema shop, marketing, inventory, support to ${r};
    grant select on all tables in schema shop, marketing, inventory, support to ${r};
  `);
}

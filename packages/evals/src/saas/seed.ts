/**
 * Writes the dash-saas company into a Postgres database: schemas public (accounts, users, plans, subscriptions,
 * subscription_items), billing (invoices, invoice_lines, payments, refunds, credits, fx_rates) and support (tickets).
 * Re-running replaces the data, so the result is the same every time for the same seed.
 */
import type postgres from "postgres";
import { generateBilling } from "./billing";
import { generateSaas } from "./model";

type Sql = postgres.Sql;

/** The database comment that marks OpenDash sample data. The connection check matches its "opendash:sample-data" prefix. */
export const SAMPLE_DATA_MARKER = "opendash:sample-data acme v1";

const DDL = `
drop schema if exists billing cascade;
drop schema if exists support cascade;
drop table if exists public.subscription_items, public.subscriptions, public.users, public.accounts, public.plans cascade;
create schema billing;
create schema support;

create table public.plans (
  id text primary key,
  name text not null,
  unit_amount_cents integer not null,
  per_seat boolean not null,
  min_seats integer not null
);
comment on column public.plans.unit_amount_cents is 'Monthly list price per unit, in cents';

create table public.accounts (
  id bigint primary key,
  name text not null,
  domain text not null,
  country char(2) not null,
  currency char(3) not null,
  industry text,
  employee_band text,
  is_test boolean not null default false,
  billing_email text,
  created_at timestamptz not null
);

create table public.users (
  id bigint primary key,
  account_id bigint not null references public.accounts (id),
  full_name text not null,
  email text not null,
  phone text,
  role text not null,
  created_at timestamptz not null,
  last_seen_at timestamptz
);

create table public.subscriptions (
  id bigint primary key,
  account_id bigint not null references public.accounts (id),
  plan_id text not null references public.plans (id),
  status text not null,
  currency char(3) not null,
  billing_interval text not null,
  seats integer not null,
  amount_cents integer not null,
  discount_pct integer not null default 0,
  started_at timestamptz not null,
  trial_ends_at timestamptz,
  canceled_at timestamptz,
  cancel_reason text,
  paused_at timestamptz,
  resumed_at timestamptz
);
comment on column public.subscriptions.amount_cents is 'List price per billing interval, in cents (set during trials too)';

create table public.subscription_items (
  id bigint primary key,
  subscription_id bigint not null references public.subscriptions (id),
  plan_id text not null references public.plans (id),
  quantity integer not null,
  unit_amount_cents integer not null,
  started_at timestamptz not null,
  ended_at timestamptz
);

create table billing.fx_rates (
  rate_date date not null,
  currency char(3) not null,
  rate_to_usd numeric(10, 4) not null,
  primary key (rate_date, currency)
);

create table billing.invoices (
  id bigint primary key,
  number text not null unique,
  account_id bigint not null references public.accounts (id),
  subscription_id bigint references public.subscriptions (id),
  currency char(3) not null,
  issued_at timestamptz not null,
  period_start timestamptz not null,
  period_end timestamptz not null,
  subtotal_cents bigint not null,
  discount_cents bigint not null,
  tax_cents bigint not null,
  total_cents bigint not null,
  status text not null
);
comment on column billing.invoices.total_cents is 'In the invoice currency, including tax';

create table billing.invoice_lines (
  id bigint primary key,
  invoice_id bigint not null references billing.invoices (id),
  kind text not null,
  plan_id text references public.plans (id),
  quantity integer not null,
  amount_cents bigint not null,
  description text
);

create table billing.payments (
  id bigint primary key,
  invoice_id bigint not null references billing.invoices (id),
  amount_cents bigint not null,
  currency char(3) not null,
  status text not null,
  method text not null,
  created_at timestamptz not null
);

create table billing.refunds (
  id bigint primary key,
  payment_id bigint not null references billing.payments (id),
  amount_cents bigint not null,
  reason text,
  created_at timestamptz not null
);

create table billing.credits (
  id bigint primary key,
  account_id bigint not null references public.accounts (id),
  amount_cents bigint not null,
  currency char(3) not null,
  reason text,
  created_at timestamptz not null
);

create table support.tickets (
  id bigint primary key,
  account_id bigint not null references public.accounts (id),
  user_id bigint references public.users (id),
  subject text not null,
  priority text not null,
  status text not null,
  channel text not null,
  created_at timestamptz not null,
  solved_at timestamptz,
  csat smallint
);

create index on public.users (account_id);
create index on public.subscriptions (account_id);
create index on public.subscription_items (subscription_id);
create index on billing.invoices (account_id);
create index on billing.invoice_lines (invoice_id);
create index on billing.payments (invoice_id);
create index on support.tickets (account_id);
`;

const ts = (t: number | null) => (t === null ? null : new Date(t));
const utcDate = (t: number) => new Date(t).toISOString().slice(0, 10);

async function insert(sql: Sql, table: string, rows: Record<string, unknown>[]) {
  if (!rows.length) return;
  const columns = Object.keys(rows[0] as object);
  const batch = Math.max(1, Math.floor(30_000 / columns.length));
  for (let i = 0; i < rows.length; i += batch) {
    await sql`insert into ${sql.unsafe(table)} ${sql(rows.slice(i, i + batch) as never, columns)}`;
  }
}

export interface SeedSummary {
  tables: Record<string, number>;
}

/** Every demo table's rows, keyed by schema.table: the same company whichever database it's loaded into. */
export function demoRows(seed = 20261007, asOf?: number): [string, Record<string, unknown>[]][] {
  const company = generateSaas(seed, asOf);
  const billing = generateBilling(company, seed);
  return [
    [
      "public.plans",
      company.plans.map((p) => ({
        id: p.id,
        name: p.name,
        unit_amount_cents: p.unitCents,
        per_seat: p.perSeat,
        min_seats: p.minSeats,
      })),
    ],
    [
      "public.accounts",
      company.accounts.map((a) => ({
        id: a.id,
        name: a.name,
        domain: a.domain,
        country: a.country,
        currency: a.currency,
        industry: a.industry,
        employee_band: a.employees,
        is_test: a.isTest,
        billing_email: a.billingEmail,
        created_at: ts(a.createdAt),
      })),
    ],
    [
      "public.users",
      company.users.map((u) => ({
        id: u.id,
        account_id: u.accountId,
        full_name: u.fullName,
        email: u.email,
        phone: u.phone,
        role: u.role,
        created_at: ts(u.createdAt),
        last_seen_at: ts(u.lastSeenAt),
      })),
    ],
    [
      "public.subscriptions",
      company.subscriptions.map((s) => ({
        id: s.id,
        account_id: s.accountId,
        plan_id: s.planId,
        status: s.status,
        currency: s.currency,
        billing_interval: s.interval,
        seats: s.seats,
        amount_cents: s.amountCents,
        discount_pct: s.discountPct,
        started_at: ts(s.startedAt),
        trial_ends_at: ts(s.trialEndsAt),
        canceled_at: ts(s.canceledAt),
        cancel_reason: s.cancelReason,
        paused_at: ts(s.pausedAt),
        resumed_at: ts(s.resumedAt),
      })),
    ],
    [
      "public.subscription_items",
      company.subscriptions.flatMap((s) =>
        s.items.map((i) => ({
          id: i.id,
          subscription_id: i.subscriptionId,
          plan_id: i.planId,
          quantity: i.quantity,
          unit_amount_cents: i.unitAmountCents,
          started_at: ts(i.startedAt),
          ended_at: ts(i.endedAt),
        })),
      ),
    ],
    [
      "billing.fx_rates",
      company.fx.map((r) => ({ rate_date: utcDate(r.date), currency: r.currency, rate_to_usd: r.rateToUsd })),
    ],
    [
      "billing.invoices",
      billing.invoices.map((i) => ({
        id: i.id,
        number: i.number,
        account_id: i.accountId,
        subscription_id: i.subscriptionId,
        currency: i.currency,
        issued_at: ts(i.issuedAt),
        period_start: ts(i.periodStart),
        period_end: ts(i.periodEnd),
        subtotal_cents: i.subtotalCents,
        discount_cents: i.discountCents,
        tax_cents: i.taxCents,
        total_cents: i.totalCents,
        status: i.status,
      })),
    ],
    [
      "billing.invoice_lines",
      billing.lines.map((l) => ({
        id: l.id,
        invoice_id: l.invoiceId,
        kind: l.kind,
        plan_id: l.planId,
        quantity: l.quantity,
        amount_cents: l.amountCents,
        description: l.description,
      })),
    ],
    [
      "billing.payments",
      billing.payments.map((p) => ({
        id: p.id,
        invoice_id: p.invoiceId,
        amount_cents: p.amountCents,
        currency: p.currency,
        status: p.status,
        method: p.method,
        created_at: ts(p.createdAt),
      })),
    ],
    [
      "billing.refunds",
      billing.refunds.map((r) => ({
        id: r.id,
        payment_id: r.paymentId,
        amount_cents: r.amountCents,
        reason: r.reason,
        created_at: ts(r.createdAt),
      })),
    ],
    [
      "billing.credits",
      billing.credits.map((c) => ({
        id: c.id,
        account_id: c.accountId,
        amount_cents: c.amountCents,
        currency: c.currency,
        reason: c.reason,
        created_at: ts(c.createdAt),
      })),
    ],
    [
      "support.tickets",
      billing.tickets.map((t) => ({
        id: t.id,
        account_id: t.accountId,
        user_id: t.userId,
        subject: t.subject,
        priority: t.priority,
        status: t.status,
        channel: t.channel,
        created_at: ts(t.createdAt),
        solved_at: ts(t.solvedAt),
        csat: t.csat,
      })),
    ],
  ];
}

/** Creates the schemas and tables and loads the data. The caller's role owns the tables. */
export async function seedSaas(sql: Sql, seed = 20261007, asOf?: number): Promise<SeedSummary> {
  await sql.unsafe(DDL);
  const summary: SeedSummary = { tables: {} };
  for (const [table, rows] of demoRows(seed, asOf)) {
    await insert(sql, table, rows);
    summary.tables[table] = rows.length;
  }
  // Statistics, as any long-running database has them: profiling reads pg_stats before sampling.
  await sql.unsafe("analyze");
  // Marks the database as OpenDash's sample data. The connection check reads this comment, so a connection to it is
  // shown with a "Sample data" badge without any configuration (packages/connectors, probe).
  await sql.unsafe(
    `do $$ begin execute format('comment on database %I is %L', current_database(), '${SAMPLE_DATA_MARKER}'); end $$`,
  );
  return summary;
}

/** Lets a login role read every demo table, now and after a re-seed. */
export async function grantReader(sql: Sql, role: string) {
  const r = `"${role.replaceAll('"', '""')}"`;
  await sql.unsafe(`
    grant usage on schema public, billing, support to ${r};
    grant select on all tables in schema public, billing, support to ${r};
  `);
}

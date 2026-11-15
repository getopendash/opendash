// Drafting fixtures: a dataset for each of a few demo tables, and how a scripted drafter finds its table.
import type { Prompt } from "./scripted";

/** A dataset for each table of the batch, each its own grain. */
export const DATASETS: Record<string, string> = {
  "public.plans": `ref: plans
label: Plans
description: The plans an account can subscribe to, one row each.
grain: one row per plan
usage_guidance: Use for plans.
primary_key: [id]
sql: |
  select p.id, p.name from public.plans p
columns:
  - { name: id, type: string }
  - { name: name, type: string, dimension: true }
measures:
  - { name: plans, expr: "count(*)" }
`,
  "billing.credits": `ref: credits
label: Credits
description: Credits given to accounts, one row each.
grain: one row per credit
usage_guidance: Use for credits given.
primary_key: [id]
time_column: created_at
sql: |
  select c.id, c.reason, c.created_at from billing.credits c
columns:
  - { name: id, type: number }
  - { name: reason, type: string, dimension: true }
  - { name: created_at, type: time }
measures:
  - { name: credits, expr: "count(*)" }
`,
  "billing.refunds": `ref: refunds
label: Refunds
description: Refunds of payments, one row each.
grain: one row per refund
usage_guidance: Use for refunds given.
primary_key: [id]
time_column: created_at
sql: |
  select r.id, r.reason, r.created_at from billing.refunds r
columns:
  - { name: id, type: number }
  - { name: reason, type: string, dimension: true }
  - { name: created_at, type: time }
measures:
  - { name: refunds, expr: "count(*)" }
`,
  "billing.fx_rates": `ref: fx_rates
label: Exchange rates
description: Each currency's rate to US dollars, one row per day.
grain: one row per day and currency
usage_guidance: Use to convert amounts to US dollars.
primary_key: [rate_date, currency]
time_column: rate_date
sql: |
  select f.rate_date, f.currency, f.rate_to_usd from billing.fx_rates f
columns:
  - { name: rate_date, type: time }
  - { name: currency, type: string, dimension: true }
  - { name: rate_to_usd, type: number }
measures:
  - { name: rates, expr: "count(*)" }
`,
};
export const TABLES = Object.keys(DATASETS);

/** The table a drafter was given: the one its brief names as picked. */
export const tableIn = (prompt: Prompt) => {
  const brief = JSON.stringify(prompt.filter((m) => m.role === "user"));
  return TABLES.find((t) => brief.includes(`- ${t}: `)) as string;
};

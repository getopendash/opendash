import type { Catalog } from "../../src/protocol.ts";

/** Acme's demo warehouse as the data API sees it: four datasets, as the portfolio App reads them. */
export const ACME: Catalog = {
  accounts: {
    title: "Accounts with their subscription",
    key: "id",
    columns: {
      id: { kind: "number" },
      name: { kind: "text", search: true },
      country: { kind: "text" },
      industry: { kind: "text", search: true },
      employee_band: { kind: "text" },
      created_at: { kind: "date" },
      plan: { kind: "text" },
      status: { kind: "text" },
      seats: { kind: "number" },
      billing: { kind: "text" },
      mrr: { kind: "number" },
      started_at: { kind: "date" },
      canceled_at: { kind: "date" },
      cancel_reason: { kind: "text" },
    },
    measures: { total_mrr: { format: "usd" } },
  },
  tickets: {
    title: "Support tickets",
    key: "id",
    columns: {
      id: { kind: "number" },
      account_id: { kind: "number" },
      account: { kind: "text", search: true },
      subject: { kind: "text", search: true },
      priority: { kind: "text" },
      status: { kind: "text" },
      channel: { kind: "text" },
      created_at: { kind: "date" },
      solved_at: { kind: "date" },
      csat: { kind: "number" },
      hours_open: { kind: "number" },
    },
    links: [{ to: "accounts", on: { account_id: "id" } }],
  },
  invoices: {
    title: "Invoices",
    key: "id",
    columns: {
      id: { kind: "number" },
      account_id: { kind: "number" },
      number: { kind: "text", search: true },
      issued_at: { kind: "date" },
      total: { kind: "number" },
      status: { kind: "text" },
    },
  },
  users: {
    title: "People at each account",
    key: "id",
    columns: {
      id: { kind: "number" },
      account_id: { kind: "number" },
      role: { kind: "text" },
      last_seen_at: { kind: "date" },
    },
  },
};

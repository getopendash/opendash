import type { Definition } from "../../src/dashboard";

export const SOURCE = "0190a000-0000-7000-8000-0000000000c1";
const source = { connection: SOURCE, dataset: "accounts" };

/** The proof's App: MRR against the period before, the accounts as rows its code may page, and a count by month. */
export const proof = (): Definition => ({
  version: 2,
  title: "Revenue this month",
  filters: {
    f_period: { kind: "period", label: "Period", default: "this_month" },
    f_plan: { kind: "select", label: "Plan", options: ["Starter", "Growth", "Scale"], default: [] },
  },
  queries: {
    q_mrr: {
      source,
      measures: { mrr: ["measure", "total_mrr"] },
      filters: { f_period: "started_at", f_plan: "plan" },
      compare: "previous_period",
      drill: "q_accounts",
    },
    q_accounts: {
      source,
      select: ["id", "name", "plan", "mrr"],
      sort: ["-mrr"],
      page: 50,
      filters: { f_period: "started_at", f_plan: "plan" },
      key: "id",
    },
    q_new: {
      source,
      measures: { accounts: ["count"] },
      by: ["created_at:month"],
      filters: { f_plan: "plan" },
      drill: "q_accounts",
    },
  },
});

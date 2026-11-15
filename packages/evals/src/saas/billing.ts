/**
 * Billing and support history for the dash-saas company: invoices (with proration lines on mid-period changes and VAT
 * by country), payments (some with a failed first attempt), refunds, credits and support tickets. None of this feeds
 * MRR, but it's where revenue, collections and support questions are answered, and where the fan-out traps live
 * (invoices × lines × payments).
 */
import { createRandom } from "../random";
import { DAY, type SaasCompany, type Subscription } from "./model";

export interface Invoice {
  id: number;
  number: string;
  accountId: number;
  subscriptionId: number;
  currency: string;
  issuedAt: number;
  periodStart: number;
  periodEnd: number;
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
  status: "paid" | "open" | "uncollectible" | "void";
}

export interface InvoiceLine {
  id: number;
  invoiceId: number;
  kind: "subscription" | "proration";
  planId: string;
  quantity: number;
  amountCents: number;
  description: string;
}

export interface Payment {
  id: number;
  invoiceId: number;
  amountCents: number;
  currency: string;
  status: "succeeded" | "failed";
  method: "card" | "ach" | "sepa_debit";
  createdAt: number;
}

export interface Refund {
  id: number;
  paymentId: number;
  amountCents: number;
  reason: string;
  createdAt: number;
}

export interface Credit {
  id: number;
  accountId: number;
  amountCents: number;
  currency: string;
  reason: string;
  createdAt: number;
}

export interface Ticket {
  id: number;
  accountId: number;
  userId: number | null;
  subject: string;
  priority: "low" | "normal" | "high" | "urgent";
  status: "open" | "pending" | "solved";
  channel: "email" | "chat" | "web";
  createdAt: number;
  solvedAt: number | null;
  csat: number | null;
}

export interface SaasBilling {
  invoices: Invoice[];
  lines: InvoiceLine[];
  payments: Payment[];
  refunds: Refund[];
  credits: Credit[];
  tickets: Ticket[];
}

const VAT: Record<string, number> = { GB: 20, DE: 19, FR: 20, NL: 21 };
const addMonths = (t: number, n: number) => {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, Math.min(d.getUTCDate(), 28), d.getUTCHours());
};
const SUBJECTS = [
  "Can't log in after password reset",
  "Invoice shows the wrong VAT number",
  "How do I add seats?",
  "Export to CSV is slow",
  "Request: SSO for our team",
  "Charged twice this month",
  "Dashboard not loading",
  "Question about annual billing",
  "Cancel my subscription",
  "API rate limit errors",
];

export function generateBilling(company: SaasCompany, seed = 20261007): SaasBilling {
  const rng = createRandom(seed ^ 0xb111);
  const asOf = company.asOf;
  const accounts = new Map(company.accounts.map((a) => [a.id, a]));
  const usersByAccount = new Map<number, number[]>();
  for (const u of company.users) usersByAccount.set(u.accountId, [...(usersByAccount.get(u.accountId) ?? []), u.id]);
  const out: SaasBilling = { invoices: [], lines: [], payments: [], refunds: [], credits: [], tickets: [] };

  const invoice = (s: Subscription, at: number, periodEnd: number, lines: Omit<InvoiceLine, "id" | "invoiceId">[]) => {
    const account = accounts.get(s.accountId);
    if (!account || lines.length === 0) return;
    const id = out.invoices.length + 1;
    const subtotal = lines.reduce((sum, l) => sum + l.amountCents, 0);
    const discount = Math.round((subtotal * s.discountPct) / 100);
    const tax = Math.round(((subtotal - discount) * (VAT[account.country] ?? 0)) / 100);
    const recent = asOf - at < 3 * DAY;
    const status: Invoice["status"] = recent ? "open" : rng.chance(0.01) ? "uncollectible" : "paid";
    out.invoices.push({
      id,
      number: `INV-${String(id).padStart(6, "0")}`,
      accountId: s.accountId,
      subscriptionId: s.id,
      currency: s.currency,
      issuedAt: at,
      periodStart: at,
      periodEnd,
      subtotalCents: subtotal,
      discountCents: discount,
      taxCents: tax,
      totalCents: subtotal - discount + tax,
      status,
    });
    for (const l of lines) out.lines.push({ id: out.lines.length + 1, invoiceId: id, ...l });
    const total = subtotal - discount + tax;
    if (status === "paid" && total > 0) {
      const method = s.currency === "EUR" ? "sepa_debit" : rng.chance(0.2) ? "ach" : "card";
      if (rng.chance(0.03)) {
        out.payments.push({
          id: out.payments.length + 1,
          invoiceId: id,
          amountCents: total,
          currency: s.currency,
          status: "failed",
          method,
          createdAt: at + DAY / 2,
        });
      }
      const paymentId = out.payments.length + 1;
      out.payments.push({
        id: paymentId,
        invoiceId: id,
        amountCents: total,
        currency: s.currency,
        status: "succeeded",
        method,
        createdAt: at + DAY,
      });
      if (rng.chance(0.015)) {
        const full = rng.chance(0.4);
        out.refunds.push({
          id: out.refunds.length + 1,
          paymentId,
          amountCents: full ? total : Math.round(total * rng.pick([0.25, 0.5])),
          reason: rng.pick(["duplicate", "requested_by_customer", "service_issue"]),
          createdAt: Math.min(asOf, at + rng.int(2, 25) * DAY),
        });
      }
    }
  };

  for (const s of company.subscriptions) {
    const months = s.interval === "year" ? 12 : 1;
    for (const item of s.items) {
      const end = item.endedAt ?? asOf;
      // A mid-period change bills the difference for the rest of the period on its own invoice.
      const previous = s.items[s.items.indexOf(item) - 1];
      if (previous && previous.endedAt === item.startedAt && s.interval === "month") {
        const diff = item.unitAmountCents * item.quantity - previous.unitAmountCents * previous.quantity;
        const remaining = Math.max(1, 30 - new Date(item.startedAt).getUTCDate());
        invoice(s, item.startedAt, addMonths(item.startedAt, 1), [
          {
            kind: "proration",
            planId: item.planId,
            quantity: item.quantity,
            amountCents: Math.round((diff * remaining) / 30),
            description: `Change to ${item.quantity} × ${item.planId} (prorated, ${remaining} days)`,
          },
        ]);
      }
      for (let at = item.startedAt; at < end && at <= asOf; at = addMonths(at, months)) {
        if (s.pausedAt !== null && at >= s.pausedAt && (s.resumedAt === null || at < s.resumedAt)) continue;
        invoice(s, at, addMonths(at, months), [
          {
            kind: "subscription",
            planId: item.planId,
            quantity: item.quantity,
            amountCents: item.unitAmountCents * item.quantity,
            description: `${item.quantity} × ${item.planId} (${s.interval}ly)`,
          },
        ]);
      }
    }
  }

  for (const a of company.accounts) {
    if (rng.chance(0.02)) {
      out.credits.push({
        id: out.credits.length + 1,
        accountId: a.id,
        amountCents: rng.pick([2_500, 5_000, 10_000]),
        currency: a.currency,
        reason: rng.pick(["goodwill", "outage", "migration"]),
        createdAt: Math.min(asOf, a.createdAt + rng.int(30, 300) * DAY),
      });
    }
    const users = usersByAccount.get(a.id) ?? [];
    for (let t = a.createdAt + rng.int(3, 40) * DAY; t <= asOf; t += rng.int(25, 120) * DAY) {
      const solved = rng.chance(0.85) ? Math.min(asOf, t + rng.int(1, 72) * 3_600_000) : null;
      out.tickets.push({
        id: out.tickets.length + 1,
        accountId: a.id,
        userId: users.length ? rng.pick(users) : null,
        subject: rng.pick(SUBJECTS),
        priority: rng.weighted([
          ["low", 30],
          ["normal", 50],
          ["high", 15],
          ["urgent", 5],
        ] as const),
        status: solved ? "solved" : rng.chance(0.5) ? "open" : "pending",
        channel: rng.pick(["email", "chat", "web"] as const),
        createdAt: t,
        solvedAt: solved,
        csat: solved && rng.chance(0.4) ? rng.int(1, 5) : null,
      });
    }
  }
  return out;
}

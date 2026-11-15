/**
 * The storylines' ground truth, and the measures behind it computed straight from the generated rows (reference.ts
 * has the same definitions in SQL, and a test checks that they agree). Every window in GROUND_TRUTH ends before
 * October 1, 2026, so the numbers are the same for any end date after it.
 */
import { DAY, day, EVENTS, etDate, START } from "./calendar";
import { TOP_VARIANT, WINTER_GLOW } from "./catalog";
import type { LineRow, LumenCompany, OrderRow } from "./types";

export const dayIndex = (t: number) => Math.round((etDate(t) - START) / DAY);

export class LumenMeasures {
  readonly fx: Map<string, number>;
  readonly orderById: Map<number, OrderRow>;
  readonly linesByOrder = new Map<number, LineRow[]>();
  readonly refundedByOrder = new Map<number, number>();

  constructor(readonly co: LumenCompany) {
    this.fx = new Map(co.fx.map((r) => [`${r.currency}:${r.rate_date}`, r.rate_to_usd]));
    this.orderById = new Map(co.orders.map((o) => [o.id, o]));
    for (const l of co.lines) {
      const list = this.linesByOrder.get(l.order_id);
      if (list) list.push(l);
      else this.linesByOrder.set(l.order_id, [l]);
    }
  }

  usd(cents: number, currency: string, i: number) {
    return currency === "USD" ? cents : cents * (this.fx.get(`${currency}:${START + i * DAY}`) as number);
  }
  /** A retail order that counts: not a test, not cancelled (either spelling). */
  ok = (o: OrderRow) => o.order_type === "retail" && !o.is_test && o.status !== "canceled" && o.status !== "cancelled";
  isGiftCard = (o: OrderRow) => (this.linesByOrder.get(o.id) ?? []).some((l) => l.line_kind === "gift_card");
  /** The merchandise after discounts, without tax, in the order's currency. */
  merchandise = (o: OrderRow) =>
    (o.subtotal_cents - o.discount_cents) / (o.tax_inclusive ? 1 + o.tax_rate_bps / 10_000 : 1);
  merchandiseUsd = (o: OrderRow) => this.usd(this.merchandise(o), o.currency, dayIndex(o.placed_at)) / 100;
  refundMerchandise = (r: { merchandise_cents: number; order_id: number }) => {
    const o = this.orderById.get(r.order_id) as OrderRow;
    return r.merchandise_cents / (o.tax_inclusive ? 1 + o.tax_rate_bps / 10_000 : 1);
  };

  /** Orders that count in New York days [from, to] (inclusive), optionally of one country. */
  orders(from: number, to: number, country?: string) {
    return this.co.orders.filter((o) => {
      const i = dayIndex(o.placed_at);
      return this.ok(o) && i >= from && i <= to && (country === undefined || o.ship_country === country);
    });
  }
  grossMerchandise(from: number, to: number) {
    return this.orders(from, to)
      .filter((o) => !this.isGiftCard(o))
      .reduce((s, o) => s + this.merchandiseUsd(o), 0);
  }
  refundedMerchandise(from: number, to: number) {
    let sum = 0;
    for (const r of this.co.refunds) {
      const o = this.orderById.get(r.order_id) as OrderRow;
      const i = dayIndex(r.created_at);
      if (o.order_type !== "retail" || o.is_test || i < from || i > to) continue;
      sum += this.usd(this.refundMerchandise(r), r.currency, i) / 100;
    }
    return sum;
  }
  netRevenue(from: number, to: number) {
    return this.grossMerchandise(from, to) - this.refundedMerchandise(from, to);
  }
  sessions(from: number, to: number, country?: string) {
    return this.co.sessions
      .filter((s) => {
        const i = Math.round((s.session_date - START) / DAY);
        return i >= from && i <= to && (country === undefined || s.country === country);
      })
      .reduce((sum, s) => sum + s.sessions, 0);
  }
  /** Merchandise orders over sessions. */
  conversion(from: number, to: number, country?: string) {
    const orders = this.orders(from, to, country).filter((o) => !this.isGiftCard(o)).length;
    return orders / this.sessions(from, to, country);
  }
  spend(campaignId: number, from: number, to: number) {
    return (
      this.co.adSpend
        .filter(
          (r) =>
            r.campaign_id === campaignId &&
            Math.round((r.spend_date - START) / DAY) >= from &&
            Math.round((r.spend_date - START) / DAY) <= to,
        )
        .reduce((s, r) => s + r.spend_cents, 0) / 100
    );
  }
  /** ROAS and net ROAS of a campaign over a window of New York days. */
  roas(campaignId: number, from: number, to: number) {
    if (this.refundedByOrder.size === 0) {
      for (const r of this.co.refunds) {
        this.refundedByOrder.set(r.order_id, (this.refundedByOrder.get(r.order_id) ?? 0) + this.refundMerchandise(r));
      }
    }
    let gross = 0;
    let net = 0;
    for (const o of this.orders(from, to)) {
      if (o.campaign_id !== campaignId || this.isGiftCard(o)) continue;
      const g = this.merchandiseUsd(o);
      gross += g;
      net += g - this.usd(this.refundedByOrder.get(o.id) ?? 0, o.currency, dayIndex(o.placed_at)) / 100;
    }
    const spend = this.spend(campaignId, from, to);
    return { spend, roas: gross / spend, netRoas: net / spend };
  }
  tickets(country: string, category: string, from: number, to: number) {
    return this.co.tickets.filter((t) => {
      const i = dayIndex(t.created_at);
      return t.country === country && t.category === category && i >= from && i <= to;
    }).length;
  }
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const r4 = (x: number) => Math.round(x * 10_000) / 10_000;
const range = (a: [number, number, number], b: [number, number, number]) => [day(...a), day(...b)] as const;

/** Computes the storylines' numbers from the generated rows. */
export function computeGroundTruth(co: LumenCompany) {
  const m = new LumenMeasures(co);
  const [bf0, bf1] = range([2025, 11, 14], [2025, 11, 27]);
  const [dec0, dec1] = range([2025, 12, 1], [2025, 12, 31]);
  const [jan0, jan1] = range([2026, 1, 1], [2026, 1, 31]);
  const [oct0, oct1] = range([2025, 10, 1], [2025, 10, 31]);
  const [pre0, pre1] = range([2026, 1, 1], [2026, 3, 9]);
  const [post0, post1] = range([2026, 3, 31], [2026, 6, 30]);
  const [wg0, wg1] = EVENTS.winterGlow;
  const [jun0, jun1] = range([2026, 6, 1], [2026, 6, 30]);
  const [jul0, jul1] = range([2026, 7, 1], [2026, 7, 31]);
  const [aug0, aug1] = range([2026, 8, 1], [2026, 8, 31]);
  const [sep0, sep1] = range([2026, 9, 1], [2026, 9, 30]);
  const refundRate = (a: number, b: number) => m.refundedMerchandise(a, b) / m.grossMerchandise(a, b);
  const paidSocial = co.campaigns.filter((c) => c.channel === "paid_social");
  const roas = new Map(paidSocial.map((c) => [c.name, m.roas(c.id, wg0, wg1)]));
  const ranked = [...roas].sort((a, b) => b[1].roas - a[1].roas);
  const rankedNet = [...roas].sort((a, b) => b[1].netRoas - a[1].netRoas);
  const winter = m.roas(WINTER_GLOW, wg0, wg1);
  const stockoutDays = new Set(
    co.stockouts
      .filter(
        (s) =>
          s.variant_id === TOP_VARIANT &&
          dayIndex(s.stockout_date + 12 * 3_600_000) >= jul0 &&
          dayIndex(s.stockout_date + 12 * 3_600_000) <= jul1,
      )
      .map((s) => s.stockout_date),
  );
  const lateRefunds = co.refunds.filter((r) => {
    const o = m.orderById.get(r.order_id) as OrderRow;
    const i = dayIndex(r.created_at);
    return r.reason === "late_delivery" && o.ship_country === "GB" && i >= sep0 && i <= sep1;
  });
  return {
    blackFriday2025: {
      orders: m.orders(EVENTS.bf25, EVENTS.bf25).length,
      averageDailyOrdersPrecedingTwoWeeks: r2(m.orders(bf0, bf1).length / 14),
    },
    januaryRefunds: {
      refundRateJanuary2026: r4(refundRate(jan0, jan1)),
      refundRateDecember2025: r4(refundRate(dec0, dec1)),
      refundRateOctober2025: r4(refundRate(oct0, oct1)),
    },
    germanyConversion: {
      before: { germany: r4(m.conversion(pre0, pre1, "DE")), unitedStates: r4(m.conversion(pre0, pre1, "US")) },
      after: { germany: r4(m.conversion(post0, post1, "DE")), unitedStates: r4(m.conversion(post0, post1, "US")) },
    },
    paidSocialRoas: {
      window: "2025-10-15 to 2026-04-30",
      bestRoas: ranked[0]?.[0],
      worstNetRoas: rankedNet.at(-1)?.[0],
      winterGlow: { spend: r2(winter.spend), roas: r2(winter.roas), netRoas: r2(winter.netRoas) },
    },
    topSkuStockout: {
      stockoutDaysJuly2026: stockoutDays.size,
      conversionJune2026: r4(m.conversion(jun0, jun1)),
      conversionJuly2026: r4(m.conversion(jul0, jul1)),
    },
    carrierDelayUk: {
      deliveryDelayTicketsSeptember2026: m.tickets("GB", "delivery_delay", sep0, sep1),
      whereIsMyOrderTicketsAugust2026: m.tickets("GB", "where_is_my_order", aug0, aug1),
      lateDeliveryRefundsSeptember2026: lateRefunds.length,
    },
  };
}

/**
 * The numbers the storylines produce for seed 20261007, pinned: a test regenerates the data and checks them, so a
 * change to the generator that moves a storyline shows up here.
 */
export const GROUND_TRUTH = {
  /** Black Friday (Nov 28, 2025) takes about three times a normal day's orders. */
  blackFriday2025: { orders: 602, averageDailyOrdersPrecedingTwoWeeks: 215.36 },
  /** The holiday returns arrive in January 2026: refunds as a share of merchandise sold, by month. */
  januaryRefunds: { refundRateJanuary2026: 0.2056, refundRateDecember2025: 0.0826, refundRateOctober2025: 0.0772 },
  /** The Halo price rise cuts conversion in Germany only: Jan 1 - Mar 9 against Mar 31 - Jun 30, 2026. */
  germanyConversion: {
    before: { germany: 0.0339, unitedStates: 0.0339 },
    after: { germany: 0.0265, unitedStates: 0.0347 },
  },
  /** Winter Glow has the best ROAS of the paid-social campaigns and, with returns netted, the worst. */
  paidSocialRoas: {
    window: "2025-10-15 to 2026-04-30",
    bestRoas: "Meta Lookalike - Winter Glow",
    worstNetRoas: "Meta Lookalike - Winter Glow",
    winterGlow: { spend: 55889.86, roas: 3.16, netRoas: 1.21 },
  },
  /** The top SKU is out of stock for 21 days in July 2026, and conversion falls. */
  topSkuStockout: { stockoutDaysJuly2026: 21, conversionJune2026: 0.0344, conversionJuly2026: 0.0325 },
  /** The carrier backlog: UK delivery-delay tickets and late-delivery refunds in September 2026. */
  carrierDelayUk: {
    deliveryDelayTicketsSeptember2026: 232,
    whereIsMyOrderTicketsAugust2026: 12,
    lateDeliveryRefundsSeptember2026: 35,
  },
};

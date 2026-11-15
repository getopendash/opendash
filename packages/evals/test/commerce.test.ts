// Lumen, the second sample company: deterministic for a seed and an end date, reconciled, carrying the traps and the
// five storylines, and the reference SQL agrees with the generator.
import { createHash, randomBytes } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  computeGroundTruth,
  defaultAsOf,
  GROUND_TRUTH,
  generateLumen,
  LUMEN_QUESTIONS,
  type LumenCompany,
  LumenMeasures,
  lumenReference,
  PINNED_AS_OF,
  parseAsOf,
  seedDemoCommerce,
} from "../src/commerce";
import { DAY, day, EVENTS, etDate, START } from "../src/commerce/calendar";
import { TOP_VARIANT } from "../src/commerce/catalog";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const dayOf = (t: number) => Math.round((etDate(t) - START) / DAY);
const LATER = Date.UTC(2026, 11, 20, 23, 59, 59);

describe("generateLumen", () => {
  const co = generateLumen(undefined, PINNED_AS_OF);
  const m = new LumenMeasures(co);

  it("is the same company for the same seed and end date", () => {
    const again = generateLumen(undefined, PINNED_AS_OF);
    expect(digest(again.orders)).toBe(digest(co.orders));
    expect(digest(again.refunds)).toBe(digest(co.refunds));
    expect(digest(again.stock)).toBe(digest(co.stock));
    expect(digest(generateLumen(1, PINNED_AS_OF).orders)).not.toBe(digest(co.orders));
  });

  it("is a sample of the planned size: orders, customers, and under a million rows", () => {
    const rows = Object.values(co).reduce((n, v) => n + (Array.isArray(v) ? v.length : 0), 0);
    expect(rows).toBeLessThan(1_000_000);
    expect(co.orders.length).toBeGreaterThan(110_000);
    expect(co.orders.length).toBeLessThan(140_000);
    expect(co.customers.length).toBeGreaterThan(60_000);
    expect(co.lines.length).toBeGreaterThan(190_000);
  });

  it("runs to the end date and not past it", () => {
    const last = co.orders.at(-1) as { placed_at: number };
    expect(last.placed_at).toBeLessThanOrEqual(PINNED_AS_OF);
    expect(last.placed_at).toBeGreaterThan(PINNED_AS_OF - 2 * DAY);
    expect(co.sessions.at(-1)?.session_date).toBe(START + dayOf(PINNED_AS_OF) * DAY);
    expect(co.fx.at(-1)?.rate_date).toBe(START + dayOf(PINNED_AS_OF) * DAY);
  });

  it("reconciles: totals, lines, discounts, payments and refunds", () => {
    // Checks collect what's wrong and assert once: a million separate expects take minutes on a slow machine.
    const wrong: string[] = [];
    const check = (ok: boolean, what: string, id: number) => {
      if (!ok && wrong.length < 20) wrong.push(`${what} (${id})`);
    };
    const linesByOrder = new Map<number, typeof co.lines>();
    for (const l of co.lines) {
      const list = linesByOrder.get(l.order_id);
      if (list) list.push(l);
      else linesByOrder.set(l.order_id, [l]);
    }
    const discountsByOrder = new Map<number, number>();
    for (const d of co.orderDiscounts) {
      if (d.applies_to === "merchandise")
        discountsByOrder.set(d.order_id, (discountsByOrder.get(d.order_id) ?? 0) + d.amount_cents);
    }
    const captured = new Map<number, number>();
    for (const p of co.payments)
      if (p.status === "captured") captured.set(p.order_id, (captured.get(p.order_id) ?? 0) + p.amount_cents);
    const refunded = new Map<number, number>();
    for (const r of co.refunds) refunded.set(r.order_id, (refunded.get(r.order_id) ?? 0) + r.amount_cents);
    const redeemed = new Map<number, number>();
    for (const r of co.redemptions) redeemed.set(r.order_id, (redeemed.get(r.order_id) ?? 0) + r.amount_cents);
    for (const o of co.orders) {
      const lines = linesByOrder.get(o.id) ?? [];
      const sold = lines.filter((l) => l.line_kind !== "component");
      check(o.subtotal_cents === sold.reduce((s, l) => s + l.line_total_cents, 0), "subtotal is its lines", o.id);
      check(o.discount_cents === (discountsByOrder.get(o.id) ?? 0), "discount is its discount rows", o.id);
      check(sold.reduce((s, l) => s + l.discount_cents, 0) === o.discount_cents, "line discounts add up", o.id);
      const base = o.subtotal_cents - o.discount_cents + o.shipping_cents;
      check(o.total_cents === (o.tax_inclusive ? base : base + o.tax_cents), "total", o.id);
      check(o.gift_card_cents === (redeemed.get(o.id) ?? 0), "gift card tender", o.id);
      if (!/^cancel/.test(o.status) && o.status !== "canceled")
        check((captured.get(o.id) ?? 0) === o.total_cents, "payments capture the total", o.id);
      check((refunded.get(o.id) ?? 0) <= o.total_cents, "refunds within the total", o.id);
      for (const l of lines) {
        if (l.line_kind !== "component")
          check(l.line_total_cents === l.unit_price_cents * l.quantity, "line total", l.id);
      }
    }
    // A bundle's components add up to the bundle.
    const partsByBundle = new Map<number, number[]>();
    for (const l of co.lines) {
      if (l.parent_line_id === null || l.parent_line_id === undefined) continue;
      const list = partsByBundle.get(l.parent_line_id);
      if (list) list.push(l.line_total_cents);
      else partsByBundle.set(l.parent_line_id, [l.line_total_cents]);
    }
    for (const b of co.lines.filter((l) => l.line_kind === "bundle")) {
      const parts = partsByBundle.get(b.id) ?? [];
      check(parts.length > 0, "a bundle has components", b.id);
      check(parts.reduce((s, x) => s + x, 0) === b.line_total_cents, "components add up to the bundle", b.id);
    }
    // Returns don't return more than was bought.
    const lineById = new Map(co.lines.map((l) => [l.id, l]));
    for (const rl of co.returnLines)
      check(
        rl.quantity <= (lineById.get(rl.order_line_id) as { quantity: number }).quantity,
        "return within the line",
        rl.id,
      );
    expect(wrong).toEqual([]);
  });

  it("has every reference pointing at a row", () => {
    const ids = <T extends { id: number }>(rows: T[]) => new Set(rows.map((r) => r.id));
    const customers = ids(co.customers);
    const orders = ids(co.orders);
    const lines = ids(co.lines);
    const variants = ids(co.variants);
    const returns = ids(co.returns);
    expect(co.orders.every((o) => customers.has(o.customer_id))).toBe(true);
    expect(co.lines.every((l) => orders.has(l.order_id) && (l.variant_id === null || variants.has(l.variant_id)))).toBe(
      true,
    );
    expect(co.lines.every((l) => l.parent_line_id === null || lines.has(l.parent_line_id))).toBe(true);
    expect(co.payments.every((p) => orders.has(p.order_id))).toBe(true);
    expect(co.shipments.every((s) => orders.has(s.order_id))).toBe(true);
    expect(co.returns.every((r) => orders.has(r.order_id))).toBe(true);
    expect(co.returnLines.every((r) => returns.has(r.return_id) && lines.has(r.order_line_id))).toBe(true);
    expect(co.refunds.every((r) => orders.has(r.order_id) && (r.return_id === null || returns.has(r.return_id)))).toBe(
      true,
    );
    expect(
      co.tickets.every((t) => customers.has(t.customer_id) && (t.order_id === null || orders.has(t.order_id))),
    ).toBe(true);
    expect(co.giftCards.every((g) => orders.has(g.purchase_order_id))).toBe(true);
    expect(new Set(co.orders.map((o) => o.id)).size).toBe(co.orders.length);
  });

  it("carries the traps a generic query gets wrong", () => {
    expect(new Set(co.orders.map((o) => o.currency))).toEqual(new Set(["USD", "EUR", "GBP", "CAD"]));
    expect(co.orders.some((o) => o.tax_inclusive) && co.orders.some((o) => !o.tax_inclusive)).toBe(true);
    expect(co.orders.some((o) => o.is_test)).toBe(true);
    expect(co.orders.some((o) => o.order_type === "wholesale")).toBe(true);
    // Statuses changed spelling on fixed days.
    const statuses = (from: number, to: number) =>
      new Set(co.orders.filter((o) => dayOf(o.placed_at) >= from && dayOf(o.placed_at) < to).map((o) => o.status));
    expect(statuses(0, EVENTS.fulfilledFrom).has("shipped")).toBe(true);
    expect(statuses(0, EVENTS.fulfilledFrom).has("fulfilled")).toBe(false);
    expect(statuses(EVENTS.fulfilledFrom, 9999).has("shipped")).toBe(false);
    expect(statuses(0, EVENTS.cancelledFrom).has("canceled")).toBe(true);
    expect(statuses(0, EVENTS.cancelledFrom).has("cancelled")).toBe(false);
    expect(statuses(EVENTS.cancelledFrom, 9999).has("canceled")).toBe(false);
    expect(co.orders.some((o) => o.cancel_reason === "fraud")).toBe(true);
    // Bundles appear as a line and as component lines.
    expect(co.lines.some((l) => l.line_kind === "bundle")).toBe(true);
    expect(co.lines.some((l) => l.line_kind === "component")).toBe(true);
    // Gift card sales are not revenue; redeeming one is a tender.
    expect(co.lines.some((l) => l.line_kind === "gift_card")).toBe(true);
    expect(co.payments.some((p) => p.method === "gift_card")).toBe(true);
    // Free shipping is a shipping waiver, not a merchandise discount.
    expect(co.orderDiscounts.some((d) => d.applies_to === "shipping")).toBe(true);
    // A person can be two customer rows with the email in another case.
    const people = new Map<string, number>();
    for (const c of co.customers) people.set(c.email.toLowerCase(), (people.get(c.email.toLowerCase()) ?? 0) + 1);
    expect([...people.values()].some((n) => n > 1)).toBe(true);
    expect(co.customers.some((c) => c.email !== c.email.toLowerCase())).toBe(true);
    // An evening order in New York is the next UTC day.
    expect(
      co.orders.some(
        (o) =>
          new Date(o.placed_at).toISOString().slice(0, 10) !== new Date(etDate(o.placed_at)).toISOString().slice(0, 10),
      ),
    ).toBe(true);
    // Soft-deleted product, and the re-SKUed variant under two SKUs.
    expect(co.products.some((p) => p.deleted_at !== null)).toBe(true);
    const oak = co.variants.find((v) => v.previous_sku !== null);
    expect(oak?.sku).toBe("AUR-T1-OAK");
    const skus = new Set(co.lines.filter((l) => l.variant_id === oak?.id).map((l) => l.sku));
    expect(skus).toEqual(new Set(["AUR-TBL-OAK", "AUR-T1-OAK"]));
    // Ad platforms claim more than the store counts; affiliates have no spend.
    const commission = new Set(co.campaigns.filter((c) => c.is_commission).map((c) => c.id));
    expect(co.adSpend.some((s) => commission.has(s.campaign_id))).toBe(false);
    const paid = new Set(co.adSpend.map((s) => s.campaign_id));
    const claimed = co.adSpend.reduce((s, r) => s + r.platform_revenue_cents, 0);
    const credited = co.orders
      .filter((o) => o.campaign_id !== null && paid.has(o.campaign_id) && m.ok(o))
      .reduce((s, o) => s + m.merchandiseUsd(o) * 100, 0);
    expect(claimed).toBeGreaterThan(credited);
  });

  it("matches the ground truth of the five storylines", () => {
    expect(computeGroundTruth(co)).toEqual(GROUND_TRUTH);
  });

  it("1: Black Friday 2025 is a spike, and the holiday returns land in January", () => {
    expect(GROUND_TRUTH.blackFriday2025.orders).toBeGreaterThan(
      2.5 * GROUND_TRUTH.blackFriday2025.averageDailyOrdersPrecedingTwoWeeks,
    );
    const r = GROUND_TRUTH.januaryRefunds;
    expect(r.refundRateJanuary2026).toBeGreaterThan(2 * r.refundRateDecember2025);
    expect(r.refundRateJanuary2026).toBeGreaterThan(2 * r.refundRateOctober2025);
  });

  it("2: the Halo price rise cuts conversion in Germany only", () => {
    const g = GROUND_TRUTH.germanyConversion;
    expect(g.after.germany / g.before.germany).toBeLessThan(0.85);
    expect(Math.abs(g.after.unitedStates / g.before.unitedStates - 1)).toBeLessThan(0.05);
    // The rise is on the order lines: a Halo variant costs 15% more in the US after March 10.
    const halo = co.variants.find((v) => v.sku === "HAL-PS-WHT")?.id;
    const usd = (from: number, to: number) =>
      co.lines.find((l) => {
        const o = m.orderById.get(l.order_id);
        return (
          l.variant_id === halo &&
          o?.currency === "USD" &&
          o.discount_cents === 0 &&
          dayOf(o.placed_at) >= from &&
          dayOf(o.placed_at) < to
        );
      })?.unit_price_cents;
    expect(usd(EVENTS.priceRise + 1, 9999)).toBeGreaterThan((usd(0, EVENTS.priceRise) as number) * 1.1);
  });

  it("3: the Winter Glow campaign has the best ROAS until returns are netted, then the worst", () => {
    const [from, to] = EVENTS.winterGlow;
    const paid = co.campaigns
      .filter((c) => c.channel === "paid_social")
      .map((c) => ({ name: c.name, ...m.roas(c.id, from, to) }));
    const best = [...paid].sort((a, b) => b.roas - a.roas)[0];
    const worst = [...paid].sort((a, b) => a.netRoas - b.netRoas)[0];
    expect(best?.name).toBe("Meta Lookalike - Winter Glow");
    expect(worst?.name).toBe("Meta Lookalike - Winter Glow");
    // And the platforms claim more than the store counts for it.
    const ad = co.adSpend.filter((r) => r.campaign_id === 11);
    expect(ad.reduce((s, r) => s + r.platform_revenue_cents, 0) / 100).toBeGreaterThan(
      m.roas(11, from, to).roas * m.spend(11, from, to),
    );
  });

  it("4: the top SKU is out of stock for 21 days in July 2026 and conversion falls", () => {
    const [s0, s1] = EVENTS.stockout;
    const out = co.stock.filter(
      (r) =>
        r.variant_id === TOP_VARIANT &&
        r.on_hand_units === 0 &&
        dayOf(r.snapshot_date + 12 * 3_600_000) >= s0 &&
        dayOf(r.snapshot_date + 12 * 3_600_000) <= s1,
    );
    expect(out.length).toBe(2 * 21);
    expect(new Set(out.map((r) => r.snapshot_date)).size).toBe(21);
    // No order for it in those days; its purchase order was delayed to the 27th.
    const lineOnStockout = co.lines.some((l) => {
      const o = m.orderById.get(l.order_id);
      return l.variant_id === TOP_VARIANT && o && dayOf(o.placed_at) >= s0 && dayOf(o.placed_at) <= s1;
    });
    expect(lineOnStockout).toBe(false);
    expect(
      co.purchaseOrders.some((p) => p.variant_id === TOP_VARIANT && p.delay_reason === "supplier port closure"),
    ).toBe(true);
    const t = GROUND_TRUTH.topSkuStockout;
    expect(t.conversionJuly2026 / t.conversionJune2026).toBeLessThan(0.97);
  });

  it("5: the UK carrier backlog raises delay tickets and late-delivery refunds in September 2026", () => {
    const c = GROUND_TRUTH.carrierDelayUk;
    expect(c.deliveryDelayTicketsSeptember2026).toBeGreaterThan(8 * Math.max(1, c.whereIsMyOrderTicketsAugust2026));
    expect(c.lateDeliveryRefundsSeptember2026).toBeGreaterThan(15);
    const slow = co.shipments.filter((s) => {
      const o = m.orderById.get(s.order_id);
      return (
        o?.ship_country === "GB" &&
        dayOf(s.shipped_at) >= EVENTS.delay[0] &&
        dayOf(s.shipped_at) <= EVENTS.delay[1] &&
        s.delivered_at !== null
      );
    });
    const usual = co.shipments.filter(
      (s) =>
        m.orderById.get(s.order_id)?.ship_country === "GB" &&
        dayOf(s.shipped_at) < EVENTS.delay[0] &&
        s.delivered_at !== null,
    );
    const avg = (rows: typeof slow) =>
      rows.reduce((n, s) => n + ((s.delivered_at as number) - s.shipped_at) / DAY, 0) / rows.length;
    expect(avg(slow)).toBeGreaterThan(avg(usual) + 2);
  });
});

describe("the end date", () => {
  const pinned = generateLumen(undefined, PINNED_AS_OF);
  const later = generateLumen(undefined, LATER);

  it("defaults to the end of yesterday (UTC) and parses a date", () => {
    expect(defaultAsOf(Date.UTC(2026, 10, 3, 5, 30))).toBe(Date.UTC(2026, 10, 2, 23, 59, 59));
    expect(defaultAsOf(Date.UTC(2026, 10, 3, 0, 0, 0))).toBe(Date.UTC(2026, 10, 2, 23, 59, 59));
    expect(parseAsOf("2026-10-07")).toBe(PINNED_AS_OF);
    expect(() => parseAsOf("07/10/2026")).toThrow();
    expect(() => parseAsOf("2024-02-01")).toThrow();
  });

  it("a later end date only adds days after it: earlier orders, sessions, spend and returns are unchanged", () => {
    const n = pinned.orders.length;
    expect(later.orders.length).toBeGreaterThan(n + 5000);
    const key = (o: LumenCompany["orders"][number]) =>
      `${o.id}|${o.placed_at}|${o.customer_id}|${o.total_cents}|${o.currency}|${o.campaign_id}`;
    expect(later.orders.slice(0, n).map(key)).toEqual(pinned.orders.map(key));
    expect(digest(later.lines.slice(0, pinned.lines.length))).toBe(digest(pinned.lines));
    const preOctober = (t: number) => t < Date.UTC(2026, 9, 1);
    expect(digest(later.sessions.filter((s) => preOctober(s.session_date)))).toBe(
      digest(pinned.sessions.filter((s) => preOctober(s.session_date))),
    );
    expect(digest(later.adSpend.filter((s) => preOctober(s.spend_date) && s.spend_date < Date.UTC(2026, 8, 25)))).toBe(
      digest(pinned.adSpend.filter((s) => preOctober(s.spend_date) && s.spend_date < Date.UTC(2026, 8, 25))),
    );
    const early = <T extends { created_at?: number; requested_at?: number }>(rows: T[]) =>
      rows.filter((r) => ((r.created_at ?? r.requested_at) as number) < Date.UTC(2026, 8, 1));
    expect(digest(early(later.returns))).toBe(digest(early(pinned.returns)));
    expect(digest(early(later.refunds))).toBe(digest(early(pinned.refunds)));
    expect(digest(early(later.tickets))).toBe(digest(early(pinned.tickets)));
    // The storylines don't depend on it.
    expect(computeGroundTruth(later)).toEqual(GROUND_TRUTH);
  });

  it("keeps a sensible shape past October 2026: the Q4 ramp and a Black Friday 2026 spike", () => {
    const m = new LumenMeasures(later);
    const perDay = (i: number) => m.orders(i, i).length;
    const normal = [...Array(14).keys()].reduce((s, k) => s + perDay(EVENTS.bf26 - 21 + k), 0) / 14;
    expect(perDay(EVENTS.bf26)).toBeGreaterThan(2.5 * normal);
    const month = (y: number, mo: number) => m.orders(day(y, mo, 1), day(y, mo, 28)).length;
    expect(month(2026, 11)).toBeGreaterThan(month(2026, 9) * 1.1);
    expect(month(2026, 11)).toBeGreaterThan(month(2025, 11) * 1.1);
    expect(later.sessions.at(-1)?.session_date).toBe(START + dayOf(LATER) * DAY);
  });
});

describe("the seeded database", () => {
  const admin = process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://opendash_owner:opendash@127.0.0.1:5444/postgres";
  const suffix = randomBytes(3).toString("hex");
  const database = `lumen_t_${suffix}`;
  const reader = `lumen_reader_t_${suffix}`;
  const m = new LumenMeasures(generateLumen(undefined, PINNED_AS_OF));
  let sql: postgres.Sql;
  const q = async (text: string, params: unknown[] = []) =>
    (await sql.unsafe(text, params as never)) as unknown as Record<string, unknown>[];

  beforeAll(async () => {
    const seeded = await seedDemoCommerce(admin, { database, reader, password: "pw-lumen", asOf: PINNED_AS_OF });
    expect(seeded).toMatchObject({ seeded: true, asOf: PINNED_AS_OF });
    const url = new URL(admin);
    url.username = reader;
    url.password = "pw-lumen";
    url.pathname = `/${database}`;
    sql = postgres(url.toString(), { max: 2, onnotice: () => {} });
  }, 300_000);

  afterAll(async () => {
    await sql?.end();
    const cluster = postgres(admin, { max: 1, onnotice: () => {} });
    await cluster.unsafe(`drop database if exists ${database} with (force)`);
    await cluster.unsafe(`drop role if exists ${reader}`);
    await cluster.end();
  }, 120_000);

  it("is read-only to its reader, marked as sample data, and left alone when asked", async () => {
    await expect(
      sql`insert into shop.discounts (id, code, kind, percent_off) values (999, 'x', 'percent', 1)`,
    ).rejects.toThrow(/permission denied/);
    const [row] = await q(
      `select shobj_description(oid, 'pg_database') as c from pg_database where datname = current_database()`,
    );
    expect(String(row?.c)).toMatch(/^opendash:sample-data lumen v1 \(data to 2026-10-07\)$/);
    const again = await seedDemoCommerce(admin, { database, reader, password: "other", onlyIfMissing: true });
    expect(again).toEqual({ seeded: false });
  });

  it("loads every row the generator made", async () => {
    const expected = new Map<string, number>([
      ["shop.orders", m.co.orders.length],
      ["shop.order_lines", m.co.lines.length],
      ["shop.refunds", m.co.refunds.length],
      ["marketing.daily_sessions", m.co.sessions.length],
      ["inventory.stock_snapshots", m.co.stock.length],
      ["support.tickets", m.co.tickets.length],
    ]);
    for (const [table, n] of expected) expect(Number((await q(`select count(*) as n from ${table}`))[0]?.n)).toBe(n);
  });

  it("answers the reference SQL the way the generator's own measures do", async () => {
    const sep = [day(2026, 9, 1), day(2026, 9, 30)] as const;
    const num = async (text: string, params: unknown[]) => Number(Object.values((await q(text, params))[0] ?? {})[0]);
    expect(await num(lumenReference.ORDERS_SQL, ["2026-09-01", "2026-10-01"])).toBe(m.orders(sep[0], sep[1]).length);
    expect(await num(lumenReference.GROSS_MERCHANDISE_SQL, ["2026-09-01", "2026-10-01"])).toBeCloseTo(
      m.grossMerchandise(sep[0], sep[1]),
      0,
    );
    expect(await num(lumenReference.REFUNDED_MERCHANDISE_SQL, ["2026-09-01", "2026-10-01"])).toBeCloseTo(
      m.refundedMerchandise(sep[0], sep[1]),
      0,
    );
    const rows = await q(lumenReference.CONVERSION_BY_COUNTRY_SQL, ["2026-04-01", "2026-05-01"]);
    const de = Number(rows.find((r) => r.country === "DE")?.conversion);
    expect(de).toBeCloseTo(m.conversion(day(2026, 4, 1), day(2026, 4, 30), "DE"), 6);
    const roas = await q(lumenReference.ROAS_BY_CAMPAIGN_SQL, ["2025-10-15", "2026-05-01"]);
    const winter = roas.find((r) => Number(r.campaign_id) === 11);
    expect(Number(winter?.roas)).toBeCloseTo(m.roas(11, EVENTS.winterGlow[0], EVENTS.winterGlow[1]).roas, 2);
    expect(Number(winter?.net_roas)).toBeCloseTo(m.roas(11, EVENTS.winterGlow[0], EVENTS.winterGlow[1]).netRoas, 2);
  });

  it("grades every reference question against the data", async () => {
    expect(LUMEN_QUESTIONS.length).toBeGreaterThanOrEqual(25);
    expect(new Set(LUMEN_QUESTIONS.map((x) => x.id)).size).toBe(LUMEN_QUESTIONS.length);
    for (const n of [1, 2, 3, 4, 5]) expect(LUMEN_QUESTIONS.some((x) => x.storyline === n)).toBe(true);
    for (const question of LUMEN_QUESTIONS) {
      const expectation = await question.expect(q);
      if (expectation.kind === "numbers") {
        for (const g of expectation.groups)
          for (const e of g) expect(Number.isFinite(e.value), `${question.id}: ${e.label}`).toBe(true);
        expect(
          expectation.groups.flat().some((e) => e.value !== 0),
          question.id,
        ).toBe(true);
      } else if (expectation.kind === "texts") {
        expect(
          expectation.texts.flat().every((t) => t.length > 0),
          question.id,
        ).toBe(true);
      }
    }
  });

  it("the storylines show in the data a question reads", async () => {
    const answers = new Map<string, unknown>();
    for (const question of LUMEN_QUESTIONS) answers.set(question.id, await question.expect(q));
    const nums = (id: string) =>
      (answers.get(id) as { groups: { label: string; value: number }[][] }).groups[0] as {
        label: string;
        value: number;
      }[];
    const texts = (id: string) => (answers.get(id) as { texts: string[][] }).texts[0] as string[];
    expect(nums("stockout_days_july")[0]?.value).toBe(21);
    expect(texts("best_roas_paid_social")[0]).toBe("Meta Lookalike - Winter Glow");
    expect(texts("worst_net_roas_paid_social")[0]).toBe("Meta Lookalike - Winter Glow");
    expect(nums("conversion_de_fr_apr26").map((n) => n.label)).toEqual(["Germany", "France"]);
    expect(texts("top_sku_12m")[0]).toBe("Aurora Table Lamp - Brushed Brass");
    expect(texts("top_units_12m").join(" ")).not.toMatch(/Aurora Table Lamp - Brushed Brass/);
    expect(nums("bf_orders")[0]?.value).toBe(GROUND_TRUTH.blackFriday2025.orders);
    expect(nums("gb_delay_tickets_sep26")[0]?.value).toBe(
      GROUND_TRUTH.carrierDelayUk.deliveryDelayTicketsSeptember2026,
    );
    expect(nums("refund_rate_jan26")[0]?.value).toBeCloseTo(GROUND_TRUTH.januaryRefunds.refundRateJanuary2026, 3);
  });
});

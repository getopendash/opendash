/**
 * Lumen: a direct-to-consumer home-lighting and homewares brand (docs/evals/DASHBENCH.md), the second sample company.
 * Deterministic for a given seed and end date (`asOf`): days are simulated in order from October 1, 2024, so a later
 * `asOf` only adds days after it. The storylines sit on fixed dates and hold for any `asOf` after them.
 *
 * The business is simulated, not filled in: traffic by campaign and country (paid traffic follows spend), orders from
 * sessions times conversion, repeat orders from each customer's own schedule, then shipments, returns, refunds, support
 * tickets and warehouse stock from the orders. Everything is in the order's currency, in cents.
 *
 * Traps, as in DashBench, that a generic SQL agent gets wrong:
 * - amounts are cents, in four currencies (USD, EUR, GBP, CAD) with a daily shop.fx_rates table of rates to USD;
 * - prices include VAT in the UK and EU and exclude sales tax in the US and Canada (orders.tax_inclusive): net revenue
 *   divides the merchandise by 1 + tax_rate_bps / 10000 in the first and not in the second;
 * - test orders (is_test) and fraud- or customer-cancelled orders are not revenue; wholesale orders (order_type)
 *   share the table with retail ones, at half price and no tax;
 * - statuses changed spelling: 'shipped' became 'fulfilled' on 2025-04-15 and 'canceled' became 'cancelled' on 2025-06-01;
 * - a bundle appears as one 'bundle' line and again as its 'component' lines: revenue counts the bundle, units and
 *   stock count the components, and summing every line counts it twice;
 * - a gift card sold is a liability, not revenue (gift-card-only orders); redeeming one is a tender (a 'gift_card'
 *   payment), not a sale, so payments by method are not sales by channel;
 * - discounts are on merchandise (orders.discount_cents), free shipping is only a shipping waiver, and refunds can be
 *   partial (goodwill) or of one line;
 * - returns arrive weeks after the order: net revenue by order month and by refund month differ;
 * - guest checkout and accounts make duplicate customers: one person can be two rows, with the email in different case;
 * - order timestamps are UTC, and the store reports in America/New_York: an evening order is the next UTC day, and a
 *   month's last evening belongs to the next UTC month;
 * - products are soft-deleted (deleted_at) and keep their orders; a variant was re-SKUed on 2025-09-01 (order lines keep
 *   the SKU of their day, so grouping by sku splits one variant; group by variant_id);
 * - the Halo line's list price rose 15% on 2026-03-10: variants.price_usd_cents is today's price only;
 * - paid-media platforms report their own conversions and revenue, which are more than the store's own, and affiliate
 *   campaigns are paid by commission, with no spend rows.
 *
 * Storylines (GROUND_TRUTH in truth.ts has their numbers):
 * 1. Black Friday 2025 (Nov 28) is a spike; its holiday returns arrive in January 2026, a refund spike.
 * 2. The Halo price rise on 2026-03-10 cuts conversion in Germany only.
 * 3. "Meta Lookalike - Winter Glow" has the best return on ad spend of the paid-social campaigns until its returns are
 *    netted, and then the worst.
 * 4. The top SKU (Aurora Table Lamp, Brushed Brass) is out of stock from 2026-07-06 to 2026-07-26 and conversion dips.
 * 5. A carrier backlog (Parcelo, UK) from 2026-09-08 to 2026-09-30 raises delivery-delay tickets and late-delivery refunds.
 */
import { createRandom, type Random } from "../random";
import {
  DAY,
  day,
  defaultAsOf,
  EVENTS,
  etDate,
  etInstant,
  eventTraffic,
  HOUR,
  hourWeights,
  inRange,
  lastDayIndex,
  START,
  season,
  weekday,
} from "./calendar";
import {
  BUNDLES,
  type BundleDef,
  bundleUsd,
  CAMPAIGNS,
  type CampaignDef,
  type Category,
  COUNTRY_CODES,
  type CountryCode,
  type Currency,
  DISCOUNTS,
  EMAIL_DOMAINS,
  FIRST_NAMES,
  HALO_RISE,
  LAST_NAMES,
  MARKETS,
  PRICE_FACTOR,
  PRODUCTS,
  type ProductDef,
  priceEnding9,
  RESKU_NEW,
  RESKU_VARIANT,
  TOP_VARIANT,
  UNPAID,
  VARIANTS,
  type VariantDef,
  variantBySku,
  WAREHOUSES,
  WHOLESALE_NAMES,
} from "./catalog";
import type {
  AdSpendRow,
  FxRow,
  LineRow,
  LumenCompany,
  OrderDiscountRow,
  OrderRow,
  PaymentRow,
  PurchaseOrderRow,
  RefundRow,
  ReturnLineRow,
  ReturnRow,
  SessionRow,
  TicketRow,
} from "./types";

export const DEFAULT_SEED = 20261007;

/** Tuning: monthly growth of traffic, and the scale of every paid and unpaid source. */
const GROWTH = 1.03;
const SCALE = 1.12;

// -----------------------------------------------------------------------------------------------------------------

interface Person {
  id: number;
  first: string;
  last: string;
  email: string;
  country: CountryCode;
  region: string | null;
  device: "mobile" | "desktop";
  persona: "drifter" | "regular" | "loyal";
  guest: boolean;
  fav: Category | null;
  channel: string;
  campaignId: number | null;
  orders: number;
  lastOrderAt: number;
  guestRow: number | null;
  accountRow: number | null;
  optIn: boolean;
  /** An account created on the way, in another case of the email. */
  upperCaseAccount: boolean;
}

interface Source {
  key: string;
  campaign: CampaignDef | null;
  channel: string;
  budget: number;
  cpc: number;
  cr: number;
  mobile: number;
  from: number;
  to: number;
  geo: Partial<Record<CountryCode, number>>;
  tilt: Partial<Record<Category, number>>;
  returns: number;
  paid: boolean;
}

interface Draft {
  kind: "retail" | "wholesale" | "gift_card" | "test";
  person: Person;
  at: number;
  d: number;
  channel: string;
  campaignId: number | null;
  device: "mobile" | "desktop";
  tilt: Partial<Record<Category, number>>;
  repeat: boolean;
}

interface GiftCardState {
  id: number;
  currency: Currency;
  balance: number;
  issuedAt: number;
}

const CATEGORY_SEASON: Record<Category, number[]> = {
  // Month by month, January to December.
  candles: [1, 0.9, 0.85, 0.85, 0.8, 0.75, 0.75, 0.8, 0.95, 1.3, 1.9, 2.2],
  lamps: [0.9, 0.85, 0.9, 0.9, 0.9, 0.85, 0.85, 0.9, 1.0, 1.25, 1.35, 1.3],
  pendants: [0.9, 0.9, 1.0, 1.1, 1.1, 1.0, 0.9, 0.9, 1.0, 1.1, 1.1, 1.0],
  textiles: [1.1, 1.0, 0.9, 0.85, 0.8, 0.7, 0.7, 0.8, 1.1, 1.4, 1.6, 1.5],
  ceramics: [0.9, 0.9, 1.0, 1.1, 1.2, 1.0, 0.9, 0.9, 1.0, 1.0, 1.2, 1.5],
  smart: [1.0, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 1.0, 1.1, 1.6, 1.5],
  rugs: [0.9, 0.9, 1.0, 1.1, 1.1, 0.9, 0.8, 1.0, 1.4, 1.5, 1.3, 1.1],
};
const monthOf = (i: number) => new Date(START + i * DAY).getUTCMonth();

const PRODUCT_BY_ID = new Map(PRODUCTS.map((p) => [p.id, p]));
const VARIANTS_OF = new Map(PRODUCTS.map((p) => [p.id, VARIANTS.filter((v) => v.productId === p.id)]));
const BUNDLE_WEIGHTS: (readonly [BundleDef, number])[] = [
  [BUNDLES[0] as BundleDef, 40],
  [BUNDLES[1] as BundleDef, 20],
  [BUNDLES[2] as BundleDef, 15],
  [BUNDLES[3] as BundleDef, 25],
];

/** A per-entity random stream: the same whatever the end date, so earlier days never change. */
const subRandom = (seed: number, kind: number, id: number) =>
  createRandom((seed ^ Math.imul(kind + 1, 0x9e3779b1) ^ Math.imul(id + 1, 0x85ebca6b)) >>> 0);

export function generateLumen(seed = DEFAULT_SEED, asOf = defaultAsOf()): LumenCompany {
  const rng = createRandom(seed);
  const lastDay = lastDayIndex(asOf);
  const gauss = () => {
    const u = Math.max(rng.next(), 1e-9);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng.next());
  };
  const poisson = (lambda: number) => {
    if (lambda <= 0) return 0;
    if (lambda < 30) {
      const limit = Math.exp(-lambda);
      let k = 0;
      let p = 1;
      do {
        k++;
        p *= rng.next();
      } while (p > limit);
      return k - 1;
    }
    return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * gauss()));
  };

  const co: LumenCompany = {
    asOf,
    fx: [],
    customers: [],
    addresses: [],
    products: [],
    variants: [],
    bundles: [],
    bundleItems: [],
    discounts: [],
    orders: [],
    lines: [],
    orderDiscounts: [],
    giftCards: [],
    redemptions: [],
    payments: [],
    shipments: [],
    returns: [],
    returnLines: [],
    refunds: [],
    campaigns: [],
    adSpend: [],
    sessions: [],
    warehouses: WAREHOUSES.map((w) => ({ ...w })),
    stock: [],
    purchaseOrders: [],
    stockouts: [],
    tickets: [],
  };

  // --- FX: daily rates to USD, a slow random walk ---------------------------------------------------------------
  const fxByDay = { EUR: [] as number[], GBP: [] as number[], CAD: [] as number[] };
  {
    // Its own random stream: a longer history must not move the random numbers the orders use.
    const fr = subRandom(seed, 0, 0);
    let eur = 1.08;
    let gbp = 1.26;
    let cad = 0.73;
    for (let i = 0; i <= lastDay; i++) {
      eur = Math.min(1.15, Math.max(1.03, eur + (fr.next() - 0.5) * 0.006));
      gbp = Math.min(1.32, Math.max(1.2, gbp + (fr.next() - 0.5) * 0.006));
      cad = Math.min(0.76, Math.max(0.69, cad + (fr.next() - 0.5) * 0.003));
      const date = START + i * DAY;
      const r = (x: number) => Math.round(x * 10_000) / 10_000;
      fxByDay.EUR.push(r(eur));
      fxByDay.GBP.push(r(gbp));
      fxByDay.CAD.push(r(cad));
      co.fx.push({ rate_date: date, currency: "EUR", rate_to_usd: r(eur) } satisfies FxRow);
      co.fx.push({ rate_date: date, currency: "GBP", rate_to_usd: r(gbp) } satisfies FxRow);
      co.fx.push({ rate_date: date, currency: "CAD", rate_to_usd: r(cad) } satisfies FxRow);
    }
  }
  const toUsd = (cents: number, currency: Currency, i: number) =>
    currency === "USD" ? cents : cents * (fxByDay[currency][Math.min(i, lastDay)] as number);

  // --- Catalog rows ---------------------------------------------------------------------------------------------
  for (const p of PRODUCTS) {
    co.products.push({
      id: p.id,
      name: p.name,
      product_line: p.line,
      category: p.category,
      status: p.deletedAt === undefined || p.deletedAt > lastDay ? "active" : "discontinued",
      created_at: Date.UTC(2024, 5, 1),
      deleted_at: p.deletedAt === undefined || p.deletedAt > lastDay ? null : etInstant(p.deletedAt, 9, 0, 0),
    });
  }
  for (const v of VARIANTS) {
    const p = PRODUCT_BY_ID.get(v.productId) as ProductDef;
    const reSkued = v.id === RESKU_VARIANT && EVENTS.reSku <= lastDay;
    const currentUsd = p.line === "Halo" && lastDay >= EVENTS.priceRise ? v.usd * HALO_RISE : v.usd;
    co.variants.push({
      id: v.id,
      product_id: v.productId,
      sku: reSkued ? RESKU_NEW : v.sku,
      option_name: v.option,
      price_usd_cents: priceEnding9(currentUsd) * 100,
      unit_cost_cents: Math.round(v.usd * p.cost * 100),
      weight_g: p.weightG,
      is_active: !(p.deletedAt !== undefined && p.deletedAt <= lastDay),
      previous_sku: reSkued ? v.sku : null,
      sku_changed_at: reSkued ? etInstant(EVENTS.reSku, 2, 0, 0) : null,
    });
  }
  for (const b of BUNDLES) {
    co.bundles.push({ id: b.id, name: b.name, sku: b.sku, price_usd_cents: bundleUsd(b) * 100 });
    for (const i of b.items)
      co.bundleItems.push({ bundle_id: b.id, variant_id: variantBySku(i.sku).id, quantity: i.quantity });
  }
  for (const d of DISCOUNTS) co.discounts.push({ id: d.id, code: d.code, kind: d.kind, percent_off: d.value });

  // --- Prices ---------------------------------------------------------------------------------------------------
  const priceCache = new Map<string, number>();
  const variantPrice = (v: VariantDef, currency: Currency, i: number) => {
    const p = PRODUCT_BY_ID.get(v.productId) as ProductDef;
    const rise = p.line === "Halo" && i >= EVENTS.priceRise;
    const key = `${v.id}:${currency}:${rise}`;
    let cents = priceCache.get(key);
    if (cents === undefined) {
      cents = priceEnding9(v.usd * (rise ? HALO_RISE : 1) * PRICE_FACTOR[currency]) * 100;
      priceCache.set(key, cents);
    }
    return cents;
  };
  const bundlePrice = (b: BundleDef, currency: Currency) => priceEnding9(bundleUsd(b) * PRICE_FACTOR[currency]) * 100;
  const skuOn = (v: VariantDef, i: number) => (v.id === RESKU_VARIANT && i >= EVENTS.reSku ? RESKU_NEW : v.sku);

  // --- Sources of traffic ----------------------------------------------------------------------------------------
  const trafficShares = Object.fromEntries(COUNTRY_CODES.map((c) => [c, MARKETS[c].traffic])) as Record<
    CountryCode,
    number
  >;
  const sources: Source[] = [];
  for (const c of CAMPAIGNS) {
    sources.push({
      key: `c${c.id}`,
      campaign: c,
      channel: c.channel,
      budget: c.budget,
      cpc: c.cpc,
      cr: c.cr,
      mobile: c.mobile,
      from: c.from ?? 0,
      to: c.to ?? 100_000,
      geo: c.geo ?? trafficShares,
      tilt: c.tilt ?? {},
      returns: c.returns ?? 1,
      paid: c.channel === "paid_search" || c.channel === "paid_social",
    });
  }
  for (const u of UNPAID) {
    sources.push({
      key: u.channel,
      campaign: null,
      channel: u.channel,
      budget: u.budget,
      cpc: 0,
      cr: u.cr,
      mobile: u.mobile,
      from: 0,
      to: 100_000,
      geo: trafficShares,
      tilt: {},
      returns: 1,
      paid: false,
    });
  }
  for (const c of CAMPAIGNS) {
    co.campaigns.push({
      id: c.id,
      name: c.name,
      channel: c.channel,
      platform: c.platform,
      objective: c.objective,
      is_commission: c.commission === true,
      start_date: START + (c.from ?? 0) * DAY,
      end_date: c.to === undefined || c.to > lastDay ? null : START + c.to * DAY,
    });
  }
  const emailCampaigns = CAMPAIGNS.filter((c) => c.channel === "email");
  const spendIdx = (d: number) => {
    const t = eventTraffic(d);
    return season(d) ** 0.8 * t.sessions ** 0.55;
  };

  // --- People, orders, state -------------------------------------------------------------------------------------
  const emails = new Set<string>();
  const people: Person[] = [];
  const schedule = new Map<number, Person[]>();
  const openCards: GiftCardState[] = [];
  let nextOrder = 1;
  let nextLine = 1;
  let nextCustomer = 1;
  let nextAddress = 1;
  let nextCard = 1;
  let nextRedemption = 1;
  let nextPayment = 1;
  const regionOf = (c: CountryCode) => {
    const m = MARKETS[c];
    return rng.weighted(m.regions.map((r) => [r, r[2]] as const));
  };
  const hourDist = new Map(COUNTRY_CODES.map((c) => [c, hourWeights(c).map((w, h) => [h, w] as const)]));
  const sample = (items: readonly (readonly [number, number])[]) => rng.weighted(items);

  let personSeq = 0;
  const newPerson = (
    country: CountryCode,
    device: "mobile" | "desktop",
    src: Source | null,
    channel: string,
    register = true,
  ): Person => {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    let email = "";
    do {
      email = `${first}.${last}${rng.int(1, 9999)}@${rng.pick(EMAIL_DOMAINS[country])}`
        .toLowerCase()
        .replaceAll(" ", "");
    } while (emails.has(email));
    emails.add(email);
    const [region] = regionOf(country);
    const persona = rng.weighted([
      ["drifter", 44],
      ["regular", 41],
      ["loyal", 15],
    ] as const);
    const favCats: Category[] = ["lamps", "pendants", "candles", "textiles", "ceramics", "smart", "rugs"];
    const person: Person = {
      id: ++personSeq,
      first,
      last,
      email,
      country,
      region: region as string | null,
      device,
      persona,
      guest: rng.chance(0.44),
      fav: rng.chance(0.4) ? rng.pick(favCats) : null,
      channel,
      campaignId: src?.campaign?.id ?? null,
      orders: 0,
      lastOrderAt: 0,
      guestRow: null,
      accountRow: null,
      optIn: rng.chance(0.62),
      upperCaseAccount: rng.chance(0.3),
    };
    if (register) people.push(person);
    return person;
  };

  const sessionCells = new Map<string, number>();
  const addSessions = (channel: string, country: CountryCode, device: string, n: number) => {
    const k = `${channel}|${country}|${device}`;
    sessionCells.set(k, (sessionCells.get(k) ?? 0) + n);
  };

  // Wholesale accounts: a few dozen shops that order every month or so, with a start date each.
  interface Wholesale {
    person: Person;
    company: string;
    start: number;
    next: number;
    every: number;
  }
  const wholesalers: Wholesale[] = [];
  for (let k = 0; k < 44; k++) {
    const country = rng.weighted([
      ["US", 50],
      ["CA", 12],
      ["GB", 14],
      ["DE", 12],
      ["FR", 7],
      ["NL", 5],
    ] as const);
    const person = newPerson(country, "desktop", null, "wholesale", false);
    person.guest = false;
    const start = Math.round((k / 44) ** 0.9 * 640) + rng.int(0, 12);
    wholesalers.push({
      person,
      company: WHOLESALE_NAMES[k % WHOLESALE_NAMES.length] as string,
      start,
      next: start,
      every: rng.int(26, 70),
    });
    person.email = `orders@${(WHOLESALE_NAMES[k % WHOLESALE_NAMES.length] as string).toLowerCase().replace(/[^a-z0-9]+/g, "")}.example`;
  }
  const testers = Array.from({ length: 4 }, (_, k) => {
    const person = newPerson("US", "desktop", null, "internal", false);
    person.email = `qa${k + 1}@lumen.test`;
    person.guest = false;
    return person;
  });

  const customerRow = (p: Person, at: number, kind: Draft["kind"]): number => {
    const wholesale = wholesalers.find((w) => w.person === p);
    if (wholesale || kind === "test") {
      if (p.accountRow === null) {
        p.accountRow = nextCustomer++;
        co.customers.push({
          id: p.accountRow,
          email: p.email,
          first_name: wholesale ? null : p.first,
          last_name: wholesale ? null : p.last,
          country: p.country,
          is_guest: false,
          is_wholesale: Boolean(wholesale),
          company_name: wholesale?.company ?? null,
          marketing_opt_in: false,
          acquisition_channel: wholesale ? "wholesale" : "internal",
          created_at: at - 5 * 60_000,
        });
      }
      return p.accountRow;
    }
    const account = (when: number, email: string) => {
      const id = nextCustomer++;
      co.customers.push({
        id,
        email,
        first_name: p.first,
        last_name: p.last,
        country: p.country,
        is_guest: false,
        is_wholesale: false,
        company_name: null,
        marketing_opt_in: p.optIn,
        acquisition_channel: p.channel,
        created_at: when,
      });
      co.addresses.push({
        id: nextAddress++,
        customer_id: id,
        country: p.country,
        region: p.region,
        postal_code: `${rng.int(10_000, 99_999)}`,
        city: "On file",
        is_default: true,
      });
      return id;
    };
    const cased = (e: string) => e.charAt(0).toUpperCase() + e.slice(1);
    if (!p.guest) {
      if (p.accountRow === null) p.accountRow = account(at - 3 * 60_000, p.upperCaseAccount ? cased(p.email) : p.email);
      return p.accountRow;
    }
    if (p.accountRow !== null) return p.accountRow;
    if (p.guestRow !== null && p.orders >= 1 && rng.chance(0.12)) {
      // A guest who registers: a second customer row, with the email in another case.
      p.accountRow = account(at - 60_000, cased(p.email));
      return p.accountRow;
    }
    if (p.guestRow === null) {
      p.guestRow = nextCustomer++;
      co.customers.push({
        id: p.guestRow,
        email: p.email,
        first_name: p.first,
        last_name: p.last,
        country: p.country,
        is_guest: true,
        is_wholesale: false,
        company_name: null,
        marketing_opt_in: p.optIn,
        acquisition_channel: p.channel,
        created_at: at,
      });
    }
    return p.guestRow;
  };

  const productWeight = (p: ProductDef, d: number, draft: Draft, person: Person) => {
    if (p.availableFrom !== undefined && d < p.availableFrom) return 0;
    if (p.deletedAt !== undefined && d >= p.deletedAt) return 0;
    let w = p.pop * (CATEGORY_SEASON[p.category][monthOf(d)] as number) * (draft.tilt[p.category] ?? 1);
    if (person.country === "DE" && p.line === "Halo" && d >= EVENTS.priceRise) w *= 0.28;
    if (person.fav === p.category) w *= 1.8;
    return w;
  };
  const stockedOut = (d: number) => inRange(d, EVENTS.stockout);

  interface DraftLine {
    kind: LineRow["line_kind"];
    variant: VariantDef | null;
    bundle: BundleDef | null;
    quantity: number;
    parent: number | null;
  }
  const pickVariant = (p: ProductDef, d: number): VariantDef => {
    const vs = (VARIANTS_OF.get(p.id) as VariantDef[]).filter((v) => !(v.id === TOP_VARIANT && stockedOut(d)));
    return rng.weighted(vs.map((v) => [v, v.share] as const));
  };
  const composeRetail = (draft: Draft, person: Person, d: number): DraftLine[] => {
    const lines: DraftLine[] = [];
    const bundleP = monthOf(d) >= 10 ? 0.12 : 0.075;
    const useBundle = rng.chance(bundleP);
    const nItems = useBundle
      ? rng.chance(0.4)
        ? 1
        : 0
      : sample([
          [1, 62],
          [2, 25],
          [3, 9],
          [4, 3],
          [5, 1],
        ]);
    if (useBundle) {
      const bundle = rng.weighted(BUNDLE_WEIGHTS);
      lines.push({ kind: "bundle", variant: null, bundle, quantity: 1, parent: null });
    }
    const weights = PRODUCTS.map((p) => [p, productWeight(p, d, draft, person)] as const).filter(([, w]) => w > 0);
    for (let k = 0; k < nItems; k++) {
      const p = rng.weighted(weights);
      const v = pickVariant(p, d);
      const qty =
        p.category === "candles"
          ? sample([
              [1, 60],
              [2, 25],
              [3, 15],
            ])
          : p.id === 10
            ? sample([
                [1, 55],
                [2, 30],
                [4, 15],
              ])
            : sample([
                [1, 90],
                [2, 10],
              ]);
      const existing = lines.find((l) => l.kind === "item" && l.variant === v);
      if (existing) existing.quantity += qty;
      else lines.push({ kind: "item", variant: v, bundle: null, quantity: qty, parent: null });
    }
    return lines;
  };
  const composeWholesale = (d: number): DraftLine[] => {
    const active = PRODUCTS.filter((p) => (p.availableFrom ?? 0) <= d && (p.deletedAt ?? 99_999) > d);
    const n = rng.int(3, 9);
    const lines: DraftLine[] = [];
    for (let k = 0; k < n; k++) {
      const p = rng.pick(active);
      const v = rng.pick(VARIANTS_OF.get(p.id) as VariantDef[]);
      if (lines.some((l) => l.variant === v) || (v.id === TOP_VARIANT && stockedOut(d))) continue;
      lines.push({ kind: "item", variant: v, bundle: null, quantity: 6 * rng.int(1, 6), parent: null });
    }
    return lines;
  };

  const discountFor = (d: number, orders: number, repeat: boolean, kind: Draft["kind"]) => {
    if (kind !== "retail") return null;
    const date = new Date(START + d * DAY);
    const md = date.getUTCMonth() * 100 + date.getUTCDate();
    if (inRange(d, EVENTS.promo25) && rng.chance(0.78)) return 3;
    if (inRange(d, EVENTS.promo24) && rng.chance(0.7)) return 2;
    if (inRange(d, EVENTS.promo26) && rng.chance(0.78)) return 8;
    if (md >= 214 && md <= 230 && rng.chance(0.45)) return 4;
    if (md >= 600 && md <= 613 && rng.chance(0.4)) return 5;
    if (orders === 0 && rng.chance(0.26)) return 1;
    if (repeat && rng.chance(0.14)) return 6;
    return null;
  };

  // The campaign a repeat order is credited to, and the channel.
  const repeatSource = (): { channel: string; campaignId: number | null } => {
    const r = rng.next();
    if (r < 0.42) return { channel: "email", campaignId: (rng.pick(emailCampaigns) as CampaignDef).id };
    if (r < 0.8) return { channel: "direct", campaignId: null };
    return { channel: "organic_search", campaignId: null };
  };

  const finalize = (draft: Draft) => {
    const { person, at, d } = draft;
    const market = MARKETS[person.country];
    const currency = market.currency;
    const wholesale = draft.kind === "wholesale";
    const gift = draft.kind === "gift_card";
    const test = draft.kind === "test";
    const customerId = customerRow(person, at, draft.kind);
    const orderId = nextOrder++;
    const draftLines: DraftLine[] = gift ? [] : wholesale ? composeWholesale(d) : composeRetail(draft, person, d);
    const lineRows: LineRow[] = [];
    const pushLine = (l: Omit<LineRow, "id" | "order_id">): LineRow => {
      const row = { ...l, id: nextLine++, order_id: orderId } as LineRow;
      lineRows.push(row);
      return row;
    };
    const unit = (v: VariantDef) => {
      const retail = variantPrice(v, currency, d);
      return wholesale ? Math.round((retail * 0.52) / 100) * 100 : retail;
    };
    if (gift) {
      const denomination = rng.weighted([
        [25, 20],
        [50, 38],
        [100, 30],
        [150, 12],
      ] as const);
      pushLine({
        line_kind: "gift_card",
        parent_line_id: null,
        variant_id: null,
        bundle_id: null,
        sku: `GIFT-${String(denomination).padStart(3, "0")}`,
        description: `Lumen Gift Card ${denomination}`,
        quantity: 1,
        unit_price_cents: denomination * 100,
        line_total_cents: denomination * 100,
        discount_cents: 0,
      });
    }
    for (const dl of draftLines) {
      if (dl.kind === "item" && dl.variant) {
        const v = dl.variant;
        const p = PRODUCT_BY_ID.get(v.productId) as ProductDef;
        const price = unit(v);
        pushLine({
          line_kind: "item",
          parent_line_id: null,
          variant_id: v.id,
          bundle_id: null,
          sku: skuOn(v, d),
          description: `${p.name} - ${v.option}`,
          quantity: dl.quantity,
          unit_price_cents: price,
          line_total_cents: price * dl.quantity,
          discount_cents: 0,
        });
      } else if (dl.kind === "bundle" && dl.bundle) {
        const b = dl.bundle;
        const price = bundlePrice(b, currency);
        const parent = pushLine({
          line_kind: "bundle",
          parent_line_id: null,
          variant_id: null,
          bundle_id: b.id,
          sku: b.sku,
          description: b.name,
          quantity: dl.quantity,
          unit_price_cents: price,
          line_total_cents: price * dl.quantity,
          discount_cents: 0,
        });
        // The components, priced at their share of the bundle, so adding every line counts the bundle twice.
        const parts = b.items.map((i) => ({ v: variantBySku(i.sku), q: i.quantity }));
        const listTotal = parts.reduce((s, x) => s + variantPrice(x.v, currency, d) * x.q, 0);
        let left = price;
        parts.forEach((x, k) => {
          const share =
            k === parts.length - 1 ? left : Math.round((price * variantPrice(x.v, currency, d) * x.q) / listTotal);
          left -= share;
          const p = PRODUCT_BY_ID.get(x.v.productId) as ProductDef;
          pushLine({
            line_kind: "component",
            parent_line_id: parent.id,
            variant_id: x.v.id,
            bundle_id: null,
            sku: skuOn(x.v, d),
            description: `${p.name} - ${x.v.option}`,
            quantity: x.q * dl.quantity,
            unit_price_cents: Math.round(share / (x.q * dl.quantity)),
            line_total_cents: share,
            discount_cents: 0,
          });
        });
      }
    }
    const sellable = lineRows.filter((l) => l.line_kind !== "component");
    const subtotal = sellable.reduce((s, l) => s + l.line_total_cents, 0);

    // Discounts: one merchandise code at most, and a free-shipping code.
    const discountRows: OrderDiscountRow[] = [];
    let discount = 0;
    const code = gift ? null : discountFor(d, person.orders, draft.repeat, draft.kind);
    if (code !== null) {
      const def = DISCOUNTS.find((x) => x.id === code);
      const pct = def?.value ?? 0;
      discount = Math.round((subtotal * pct) / 100);
      discountRows.push({ order_id: orderId, discount_id: code, applies_to: "merchandise", amount_cents: discount });
      let left = discount;
      sellable.forEach((l, k) => {
        const share = k === sellable.length - 1 ? left : Math.round((discount * l.line_total_cents) / subtotal);
        l.discount_cents = share;
        left -= share;
      });
    }
    const afterDiscount = subtotal - discount;
    let shipping = 0;
    if (!gift && !wholesale) {
      const fee = afterDiscount >= market.shipping.freeFrom ? 0 : market.shipping.fee;
      if (fee > 0 && rng.chance(0.07)) {
        shipping = 0;
        discountRows.push({ order_id: orderId, discount_id: 7, applies_to: "shipping", amount_cents: fee });
      } else shipping = fee;
    }
    // Tax: sales tax on top (US, Canada), VAT contained in the shown prices (UK, EU); wholesale is tax-exempt.
    const region = person.region;
    const rate = gift || wholesale ? 0 : ((market.regions.find((r) => r[0] === region) ?? market.regions[0])?.[1] ?? 0);
    const base = afterDiscount + shipping;
    let tax = 0;
    let total = base;
    if (rate > 0) {
      if (market.taxInclusive) tax = base - Math.round(base / (1 + rate / 10_000));
      else {
        tax = Math.round((base * rate) / 10_000);
        total = base + tax;
      }
    }

    // Payment: a failed attempt now and then, gift-card balance, then the rest by card, PayPal or wallet.
    let redeemed = 0;
    let cardId: number | null = null;
    const cancelled = !gift && !wholesale && !test && rng.chance(0.028);
    if (!gift && !wholesale && !test && !cancelled && openCards.length > 0) {
      const dom = new Date(START + d * DAY).getUTCDate();
      const boost = (monthOf(d) === 11 && dom >= 26) || monthOf(d) <= 1 ? 0.26 : 0.045;
      if (rng.chance(boost)) {
        const usable = openCards.filter((c) => c.currency === currency && c.issuedAt <= at - 3 * DAY);
        if (usable.length > 0) {
          const card = rng.pick(usable);
          redeemed = Math.min(card.balance, total);
          card.balance -= redeemed;
          cardId = card.id;
          if (card.balance === 0) openCards.splice(openCards.indexOf(card), 1);
        }
      }
    }
    const cancelReason = cancelled ? (rng.chance(0.3) ? "fraud" : "customer_request") : null;
    let status: string;
    if (cancelled) status = d >= EVENTS.cancelledFrom ? "cancelled" : "canceled";
    else status = d >= EVENTS.fulfilledFrom ? "fulfilled" : "shipped";

    const order: OrderRow = {
      id: orderId,
      number: `LU-${10_000 + orderId}`,
      customer_id: customerId,
      order_type: wholesale ? "wholesale" : "retail",
      is_test: test,
      placed_at: at,
      currency,
      ship_country: person.country,
      ship_region: region,
      status,
      cancel_reason: cancelReason,
      source_channel: wholesale ? "wholesale" : test ? "internal" : draft.channel,
      campaign_id: wholesale || test ? null : draft.campaignId,
      device: wholesale || test ? null : draft.device,
      subtotal_cents: subtotal,
      discount_cents: discount,
      shipping_cents: shipping,
      tax_cents: tax,
      tax_rate_bps: rate,
      tax_inclusive: market.taxInclusive && !wholesale,
      gift_card_cents: redeemed,
      total_cents: total,
    };
    co.orders.push(order);
    co.lines.push(...lineRows);
    co.orderDiscounts.push(...discountRows);
    if (gift) {
      const line = lineRows[0] as LineRow;
      const card: GiftCardState = { id: nextCard++, currency, balance: line.line_total_cents, issuedAt: at };
      co.giftCards.push({
        id: card.id,
        code: `LG-${Math.floor(rng.next() * 36 ** 8)
          .toString(36)
          .toUpperCase()
          .padStart(8, "0")}`,
        currency,
        initial_cents: line.line_total_cents,
        issued_at: at,
        purchase_order_id: orderId,
      });
      openCards.push(card);
    }
    if (cardId !== null) {
      co.redemptions.push({
        id: nextRedemption++,
        gift_card_id: cardId,
        order_id: orderId,
        amount_cents: redeemed,
        redeemed_at: at + 20_000,
      });
    }

    // Payments.
    const pay = (method: string, st: PaymentRow["status"], amount: number, offset: number) =>
      co.payments.push({
        id: nextPayment++,
        order_id: orderId,
        method,
        status: st,
        amount_cents: amount,
        currency,
        created_at: at + offset,
      });
    if (rng.chance(0.04) && !wholesale && !gift)
      pay(
        rng.weighted([
          ["card", 80],
          ["paypal", 20],
        ] as const),
        "failed",
        total - redeemed,
        8_000,
      );
    if (cancelled) pay("card", "voided", total, 30_000);
    else if (wholesale) pay("invoice", "captured", total, 30 * DAY);
    else if (test) pay("test", "captured", total, 25_000);
    else {
      if (redeemed > 0) pay("gift_card", "captured", redeemed, 22_000);
      if (total - redeemed > 0) {
        pay(
          rng.weighted([
            ["card", 62],
            ["paypal", 22],
            ["apple_pay", 14],
            ["klarna", 2],
          ] as const),
          "captured",
          total - redeemed,
          28_000,
        );
      }
    }

    if (!cancelled && !test && !wholesale) {
      person.orders++;
      person.lastOrderAt = at;
      // The next order, if there is one: a lapsing customer's chance falls with each order.
      const k = Math.min(person.orders, 5);
      const base = [0.46, 0.58, 0.65, 0.7, 0.74][k - 1] as number;
      const mult = person.persona === "drifter" ? 0.45 : person.persona === "loyal" ? 1.5 : 1;
      const median = person.persona === "drifter" ? 120 : person.persona === "loyal" ? 55 : 80;
      const more = rng.next() < Math.min(0.94, base * mult);
      const gap = Math.max(10, Math.round(median * Math.exp(0.6 * gauss())));
      if (more && !gift) {
        const due = d + gap;
        const list = schedule.get(due);
        if (list) list.push(person);
        else schedule.set(due, [person]);
      }
    } else if (!cancelled && !test) {
      person.orders++;
      person.lastOrderAt = at;
    }
  };

  // --- The days --------------------------------------------------------------------------------------------------
  const cellsOfDay = (src: Source, sessions: number) => {
    const cells: { country: CountryCode; device: "mobile" | "desktop"; sessions: number }[] = [];
    for (const country of COUNTRY_CODES) {
      const share = (src.geo[country] ?? 0) as number;
      if (share <= 0) continue;
      for (const device of ["mobile", "desktop"] as const) {
        const w = device === "mobile" ? src.mobile : 1 - src.mobile;
        cells.push({
          country,
          device,
          sessions: Math.max(0, Math.round(sessions * share * w * (0.94 + rng.next() * 0.12))),
        });
      }
    }
    return cells;
  };
  const adSpend = new Map<string, AdSpendRow>();
  const orderHour = (country: CountryCode) =>
    rng.weighted(hourDist.get(country) as readonly (readonly [number, number])[]);
  const newDraft = (
    kind: Draft["kind"],
    person: Person,
    d: number,
    channel: string,
    campaignId: number | null,
    device: "mobile" | "desktop",
    tilt: Partial<Record<Category, number>>,
    repeat: boolean,
  ): Draft => ({
    kind,
    person,
    d,
    at: etInstant(d, orderHour(person.country), rng.int(0, 59), rng.int(0, 59)),
    channel,
    campaignId,
    device,
    tilt,
    repeat,
  });

  for (let d = 0; d <= lastDay; d++) {
    const g = GROWTH ** (d / 30.4);
    const t = eventTraffic(d);
    const s = season(d);
    sessionCells.clear();
    const drafts: Draft[] = [];

    // New customers, from each source's traffic.
    for (const src of sources) {
      if (d < src.from || d > src.to) continue;
      let sessions = 0;
      if (src.paid && src.campaign) {
        const spend = src.budget * SCALE * g * spendIdx(d) * (0.9 + rng.next() * 0.2);
        const cpc =
          src.cpc *
          (1 + 0.22 * (s - 1)) *
          (t.sessions > 1 ? 1 + 0.12 * (t.sessions - 1) : 1) *
          (0.95 + rng.next() * 0.1);
        const clicks = Math.round(spend / cpc);
        sessions = Math.round(clicks * 0.92);
        const impressions = Math.round(clicks / (0.011 + rng.next() * 0.007));
        adSpend.set(`${src.campaign.id}:${d}`, {
          campaign_id: src.campaign.id,
          spend_date: START + d * DAY,
          spend_cents: Math.round(spend * 100),
          impressions,
          clicks,
          platform_conversions: 0,
          platform_revenue_cents: 0,
        });
      } else {
        sessions = Math.round(src.budget * SCALE * g * s ** 0.9 * weekday(d) * t.sessions * (0.94 + rng.next() * 0.12));
      }
      for (const cell of cellsOfDay(src, sessions)) {
        if (cell.sessions <= 0) continue;
        addSessions(src.channel, cell.country, cell.device, cell.sessions);
        const market = MARKETS[cell.country];
        let cr = src.cr * market.cr * (cell.device === "mobile" ? 0.8 : 1.5) * t.cr * (1 + 0.004 * (d / 30.4));
        if (cell.country === "DE" && d >= EVENTS.priceRise) cr *= 0.7 + 0.1 * Math.min(1, (d - EVENTS.priceRise) / 150);
        if (stockedOut(d)) cr *= 0.86;
        const n = poisson(cell.sessions * cr);
        for (let k = 0; k < n; k++) {
          const person = newPerson(cell.country, cell.device, src, src.channel);
          drafts.push(
            newDraft("retail", person, d, src.channel, src.campaign?.id ?? null, cell.device, src.tilt, false),
          );
        }
      }
    }
    const newCount = drafts.length;

    // Repeat orders: customers whose next order falls today.
    const due = schedule.get(d) ?? [];
    schedule.delete(d);
    let repeatCount = 0;
    for (const person of due) {
      const lapse = person.country === "DE" && d >= EVENTS.priceRise ? 0.2 : stockedOut(d) ? 0.1 : 0;
      if (lapse > 0 && rng.chance(lapse)) continue;
      const src = repeatSource();
      const device = rng.chance(0.85) ? person.device : person.device === "mobile" ? "desktop" : "mobile";
      drafts.push(newDraft("retail", person, d, src.channel, src.campaignId, device, {}, true));
      repeatCount++;
    }
    // The holiday gift-buying: past customers coming back in the weeks before Christmas and on Black Friday.
    const month = monthOf(d);
    const dayOfMonth = new Date(START + d * DAY).getUTCDate();
    const holiday = (month === 10 && dayOfMonth >= 12) || (month === 11 && dayOfMonth <= 20);
    if (holiday && people.length > 200) {
      const extra = poisson(people.length * 0.00032 * (t.sessions > 1 ? t.sessions : 1));
      for (let k = 0; k < extra; k++) {
        for (let tries = 0; tries < 6; tries++) {
          const person = rng.pick(people);
          if (person.orders >= 1 && person.lastOrderAt < START + (d - 25) * DAY) {
            const src = repeatSource();
            drafts.push(newDraft("retail", person, d, src.channel, src.campaignId, person.device, {}, true));
            repeatCount++;
            break;
          }
        }
      }
    }
    // Gift card purchases.
    {
      const holidayGift = month === 11 && dayOfMonth <= 23 ? 3.6 : 1;
      const n = poisson((newCount + repeatCount) * 0.016 * holidayGift);
      for (let k = 0; k < n; k++) {
        const existing = people.length > 100 && rng.chance(0.68);
        let person: Person | undefined;
        if (existing) person = rng.pick(people);
        if (!person || person.orders === 0)
          person = newPerson(
            rng.weighted(COUNTRY_CODES.map((c) => [c, MARKETS[c].traffic] as const)),
            "mobile",
            null,
            "direct",
          );
        drafts.push(
          newDraft(
            "gift_card",
            person,
            d,
            rng.chance(0.5) ? "email" : "direct",
            null,
            person.device,
            {},
            person.orders > 0,
          ),
        );
      }
    }
    // Wholesale reorders.
    for (const w of wholesalers) {
      if (d >= w.next && d >= w.start) {
        drafts.push(newDraft("wholesale", w.person, d, "wholesale", null, "desktop", {}, true));
        w.next = d + Math.max(14, Math.round(w.every * (0.8 + rng.next() * 0.4)));
      }
    }
    // Test orders from the team.
    {
      const n = poisson((newCount + repeatCount) * 0.005);
      for (let k = 0; k < n; k++)
        drafts.push(newDraft("test", rng.pick(testers), d, "internal", null, "desktop", {}, false));
    }

    // Repeat visits: each repeat order comes with a few returning sessions.
    for (const dr of drafts) {
      if (dr.repeat && dr.kind === "retail") addSessions(dr.channel, dr.person.country, dr.device, 7 + rng.int(0, 6));
    }

    // Finalize the day in time order, dropping what's after the end of the data.
    drafts.sort((a, b) => a.at - b.at);
    for (const dr of drafts) {
      if (dr.at > asOf) continue;
      finalize(dr);
    }

    // The day's sessions: all of them, but the last day only up to the end of the data.
    const elapsed = d === lastDay ? Math.min(1, Math.max(0.05, (asOf - etInstant(d, 0, 0, 0)) / DAY)) : 1;
    for (const [key, n] of sessionCells) {
      const [channel, country, device] = key.split("|") as [string, CountryCode, string];
      const count = Math.round(n * elapsed);
      if (count > 0)
        co.sessions.push({
          session_date: START + d * DAY,
          channel,
          country,
          device,
          sessions: count,
        } satisfies SessionRow);
    }
  }
  for (const row of adSpend.values()) co.adSpend.push(row);
  co.adSpend.sort((a, b) => a.spend_date - b.spend_date || a.campaign_id - b.campaign_id);

  postProcess(co, seed, asOf, lastDay, toUsd);
  return co;
}

// -----------------------------------------------------------------------------------------------------------------
// After the orders: shipments, returns and refunds, tickets, platform reports and warehouse stock. Each order has
// its own random stream, so a later end date never changes an earlier order's story.

const KIND = { ship: 1, ret: 2, goodwill: 3, ticket: 4, stock: 5, platform: 6 };

function postProcess(
  co: LumenCompany,
  seed: number,
  asOf: number,
  lastDay: number,
  toUsd: (cents: number, currency: Currency, i: number) => number,
) {
  const linesOf = new Map<number, LineRow[]>();
  for (const l of co.lines) {
    const list = linesOf.get(l.order_id);
    if (list) list.push(l);
    else linesOf.set(l.order_id, [l]);
  }
  const variantById = new Map(co.variants.map((v) => [v.id, v]));
  const productOfVariant = (variantId: number) =>
    PRODUCT_BY_ID.get((variantById.get(variantId) as { product_id: number }).product_id) as ProductDef;
  let shipmentId = 1;
  let returnId = 1;
  let returnLineId = 1;
  let refundId = 1;
  let ticketId = 1;
  const delayedOrders = new Set<number>();
  const deliveredAt = new Map<number, number>();
  const shippedAt = new Map<number, number>();

  // Shipments.
  for (const o of co.orders) {
    const r = subRandom(seed, KIND.ship, o.id);
    const lines = linesOf.get(o.id) ?? [];
    const digital = lines.length > 0 && lines.every((l) => l.line_kind === "gift_card");
    const wait = (o.order_type === "wholesale" ? 1.5 : 0.4) + r.next() * 1.8;
    const transitR = r.next();
    const delayR = r.next();
    const delayDays = 4 + r.next() * 4;
    const trackR = r.int(100_000_000, 999_999_999);
    if (o.status === "cancelled" || o.status === "canceled" || digital) continue;
    const market = MARKETS[o.ship_country];
    const shipped = o.placed_at + wait * DAY;
    let transit = market.transit[0] + transitR * (market.transit[1] - market.transit[0]);
    const shipDay = Math.round((etDate(shipped) - START) / DAY);
    if (o.ship_country === "GB" && inRange(shipDay, EVENTS.delay) && delayR < 0.72) {
      transit += delayDays;
      delayedOrders.add(o.id);
    }
    const delivered = shipped + transit * DAY;
    if (shipped > asOf) {
      o.status = "processing";
      continue;
    }
    shippedAt.set(o.id, shipped);
    deliveredAt.set(o.id, delivered);
    co.shipments.push({
      id: shipmentId++,
      order_id: o.id,
      warehouse_id: market.warehouse,
      carrier: market.carrier,
      tracking_number: `${market.carrier.slice(0, 2).toUpperCase()}${trackR}`,
      status: delivered <= asOf ? "delivered" : "in_transit",
      shipped_at: Math.round(shipped),
      delivered_at: delivered <= asOf ? Math.round(delivered) : null,
    });
  }

  // Returns, refunds, goodwill refunds.
  const refundedOf = new Map<number, number>();
  const reasonsBy = (cat: string): (readonly [string, number])[] =>
    cat === "rugs" || cat === "textiles"
      ? [
          ["too_small", 30],
          ["not_as_described", 25],
          ["changed_mind", 30],
          ["damaged", 8],
          ["wrong_color", 7],
        ]
      : cat === "ceramics" || cat === "lamps" || cat === "pendants"
        ? [
            ["damaged", 34],
            ["not_as_described", 20],
            ["changed_mind", 30],
            ["wrong_color", 8],
            ["too_small", 8],
          ]
        : [
            ["changed_mind", 40],
            ["not_as_described", 25],
            ["damaged", 15],
            ["wrong_color", 10],
            ["too_small", 10],
          ];
  const pushRefund = (
    o: OrderRow,
    returnRef: number | null,
    reason: string,
    merch: number,
    ship: number,
    at: number,
  ) => {
    const rate = o.tax_rate_bps / 10_000;
    const base = merch + ship;
    let tax = 0;
    let amount = base;
    if (rate > 0) {
      if (o.tax_inclusive) tax = base - Math.round(base / (1 + rate));
      else {
        tax = Math.round(base * rate);
        amount = base + tax;
      }
    }
    const room = o.total_cents - (refundedOf.get(o.id) ?? 0);
    if (amount <= 0 || room <= 0) return false;
    if (amount > room) {
      const f = room / amount;
      merch = Math.floor(merch * f);
      ship = Math.floor(ship * f);
      tax = Math.floor(tax * f);
      amount = o.tax_inclusive ? merch + ship : merch + ship + tax;
      if (amount <= 0) return false;
    }
    // Counted against the order whatever the end date, so an earlier refund never depends on it; recorded only once paid.
    refundedOf.set(o.id, (refundedOf.get(o.id) ?? 0) + amount);
    if (at > asOf) return false;
    co.refunds.push({
      id: refundId++,
      order_id: o.id,
      return_id: returnRef,
      reason,
      amount_cents: amount,
      merchandise_cents: merch,
      shipping_cents: ship,
      tax_cents: tax,
      currency: o.currency,
      created_at: Math.round(at),
    } satisfies RefundRow);
    return true;
  };
  const extendedWindow = (placedDay: number) => inRange(placedDay, EVENTS.holiday25);
  // Returns are recorded in refund-date order below; collect them first.
  interface PendingReturn {
    o: OrderRow;
    lines: { line: LineRow; qty: number }[];
    reason: string;
    requested: number;
    received: number;
    refundAt: number;
    refundShip: boolean;
  }
  const pending: PendingReturn[] = [];
  for (const o of co.orders) {
    const r = subRandom(seed, KIND.ret, o.id);
    const lines = (linesOf.get(o.id) ?? []).filter((l) => l.line_kind === "item" || l.line_kind === "bundle");
    const draws = lines.map(() => ({ u: r.next(), q: r.next() }));
    const timing = {
      a: r.next(),
      b: r.next(),
      c: r.next(),
      d: r.next(),
      e: r.next(),
      ext: r.next(),
      shipR: r.next(),
      reasonR: r.next(),
    };
    const delivered = deliveredAt.get(o.id);
    if (
      o.is_test ||
      o.order_type !== "retail" ||
      delivered === undefined ||
      o.status === "cancelled" ||
      o.status === "canceled"
    )
      continue;
    const placedDay = Math.round((etDate(o.placed_at) - START) / DAY);
    const campaign = o.campaign_id === null ? null : CAMPAIGNS.find((c) => c.id === o.campaign_id);
    let mult = campaign?.returns ?? 1;
    if (extendedWindow(placedDay)) mult *= 1.9;
    else if (inRange(placedDay, [day(2024, 11, 15), day(2024, 12, 24)])) mult *= 1.15;
    const chosen: { line: LineRow; qty: number }[] = [];
    lines.forEach((line, k) => {
      const draw = draws[k] as { u: number; q: number };
      const base = line.line_kind === "bundle" ? 0.06 : productOfVariant(line.variant_id as number).returnRate;
      const late = delayedOrders.has(o.id) ? 0.05 : 0;
      if (draw.u < Math.min(0.85, base * mult + late)) {
        chosen.push({ line, qty: Math.max(1, Math.min(line.quantity, Math.round(draw.q * line.quantity))) });
      }
    });
    if (chosen.length === 0) continue;
    const first = chosen[0] as { line: LineRow; qty: number };
    const cat = first.line.variant_id ? productOfVariant(first.line.variant_id).category : "bundle";
    const reasonList = reasonsBy(cat);
    let reason = (reasonList[reasonList.length - 1] as readonly [string, number])[0];
    {
      let acc = 0;
      const total = reasonList.reduce((sum, x) => sum + x[1], 0);
      for (const [name, w] of reasonList) {
        acc += w;
        if (timing.reasonR * total < acc) {
          reason = name;
          break;
        }
      }
    }
    if (delayedOrders.has(o.id) && timing.reasonR < 0.4) reason = "arrived_late";
    let requested = delivered + (2 + timing.a * 22) * DAY;
    if (extendedWindow(placedDay) && timing.ext < 0.55) {
      requested = Math.max(
        requested,
        etInstant(day(2025, 12, 26) + Math.floor(timing.b * 27), 10 + Math.floor(timing.c * 8), 0, 0),
      );
    }
    const received = requested + (4 + timing.c * 7) * DAY;
    const refundAt = received + (1 + timing.d * 4) * DAY;
    pending.push({
      o,
      lines: chosen,
      reason,
      requested,
      received,
      refundAt,
      refundShip: reason === "damaged" && timing.shipR < 0.55,
    });
  }
  pending.sort((a, b) => a.requested - b.requested || a.o.id - b.o.id);
  for (const p of pending) {
    const o = p.o;
    const recorded = p.requested <= asOf;
    const id = recorded ? returnId++ : 0;
    const status: ReturnRow["status"] = p.refundAt <= asOf ? "refunded" : p.received <= asOf ? "received" : "requested";
    if (recorded) {
      co.returns.push({
        id,
        order_id: o.id,
        status,
        reason: p.reason,
        requested_at: Math.round(p.requested),
        received_at: p.received <= asOf ? Math.round(p.received) : null,
      });
    }
    let merch = 0;
    for (const { line, qty } of p.lines) {
      if (recorded)
        co.returnLines.push({
          id: returnLineId++,
          return_id: id,
          order_line_id: line.id,
          quantity: qty,
        } satisfies ReturnLineRow);
      merch += Math.round(((line.line_total_cents - line.discount_cents) * qty) / line.quantity);
    }
    const allLines = (linesOf.get(o.id) ?? []).filter((l) => l.line_kind === "item" || l.line_kind === "bundle");
    const whole = p.lines.length === allLines.length && p.lines.every((x) => x.qty === x.line.quantity);
    pushRefund(o, recorded ? id : null, "return", merch, p.refundShip && whole ? o.shipping_cents : 0, p.refundAt);
  }
  // Goodwill refunds: late deliveries (the carrier backlog) and now and then a damaged parcel kept by the customer.
  for (const o of co.orders) {
    const r = subRandom(seed, KIND.goodwill, o.id);
    const a = r.next();
    const b = r.next();
    const pct = 0.1 + r.next() * 0.2;
    const delivered = deliveredAt.get(o.id);
    if (delivered === undefined || o.is_test || o.order_type !== "retail") continue;
    const merch = o.subtotal_cents - o.discount_cents;
    if (delayedOrders.has(o.id) && a < 0.14) {
      pushRefund(o, null, "late_delivery", Math.round(merch * pct), o.shipping_cents, delivered + (1 + b) * DAY);
    } else if (a > 0.994) {
      pushRefund(o, null, "damaged_kept", Math.round(merch * pct), 0, delivered + (3 + b * 6) * DAY);
    }
  }
  co.refunds.sort((a, b) => a.created_at - b.created_at);
  co.refunds.forEach((x, k) => {
    x.id = k + 1;
  });

  // Support tickets.
  const tickets: TicketRow[] = [];
  const pushTicket = (
    r: Random,
    o: OrderRow | null,
    customerId: number,
    country: CountryCode,
    category: string,
    createdAt: number,
    slow: boolean,
  ) => {
    const high = category === "delivery_delay" || category === "damaged_item";
    const respond = createdAt + (10 + r.next() * 540) * 60_000;
    const solve = createdAt + (slow ? 1 + r.next() * 4 : 0.15 + r.next() * 2.2) * DAY;
    const open = r.next();
    const csatDraw = r.next();
    const csatNoise = r.next();
    const channel = r.weighted([
      ["email", 62],
      ["chat", 30],
      ["social", 8],
    ] as const);
    if (createdAt > asOf) return;
    const solved = solve <= asOf && open > 0.01;
    const csat =
      solved && csatDraw < 0.55
        ? Math.max(1, Math.min(5, Math.round((slow ? 2.7 : 4.4) + (csatNoise - 0.5) * 2.4)))
        : null;
    tickets.push({
      id: 0,
      customer_id: customerId,
      order_id: o?.id ?? null,
      country,
      category,
      channel,
      priority: high ? "high" : "normal",
      status: solved ? "solved" : open < 0.5 ? "open" : "pending",
      created_at: Math.round(createdAt),
      first_response_at: respond <= asOf ? Math.round(respond) : null,
      solved_at: solved ? Math.round(solve) : null,
      csat,
    });
  };
  const returnByOrder = new Map(co.returns.map((x) => [x.order_id, x]));
  for (const o of co.orders) {
    if (o.is_test || o.order_type !== "retail") continue;
    const r = subRandom(seed, KIND.ticket, o.id);
    const lines = linesOf.get(o.id) ?? [];
    const draws = Array.from({ length: 6 }, () => r.next());
    const offsets = Array.from({ length: 6 }, () => r.next());
    const shipped = shippedAt.get(o.id);
    const delivered = deliveredAt.get(o.id);
    const country = o.ship_country;
    const delayed = delayedOrders.has(o.id);
    if (shipped !== undefined && delivered !== undefined) {
      const expected = shipped + (MARKETS[country].transit[1] + 0.5) * DAY;
      if (delayed ? (draws[0] as number) < 0.58 : (draws[0] as number) < 0.02) {
        pushTicket(
          r,
          o,
          o.customer_id,
          country,
          delayed ? "delivery_delay" : "where_is_my_order",
          expected + (0.3 + (offsets[0] as number) * 3) * DAY,
          delayed,
        );
      }
      const cat = lines.reduce(
        (m, l) =>
          l.variant_id
            ? Math.max(
                m,
                productOfVariant(l.variant_id).category === "ceramics"
                  ? 3
                  : productOfVariant(l.variant_id).category === "lamps"
                    ? 1.6
                    : 1,
              )
            : m,
        1,
      );
      if ((draws[1] as number) < 0.012 * cat) {
        pushTicket(
          r,
          o,
          o.customer_id,
          country,
          "damaged_item",
          delivered + (0.2 + (offsets[1] as number) * 4) * DAY,
          false,
        );
      }
    }
    if ((draws[2] as number) < 0.004)
      pushTicket(
        r,
        o,
        o.customer_id,
        country,
        "billing",
        o.placed_at + (0.1 + (offsets[2] as number) * 5) * DAY,
        false,
      );
    if ((draws[3] as number) < 0.006)
      pushTicket(
        r,
        o,
        o.customer_id,
        country,
        "discount_code",
        o.placed_at + (0.01 + (offsets[3] as number) * 0.5) * DAY,
        false,
      );
    const ret = returnByOrder.get(o.id);
    if (ret && (draws[4] as number) < 0.45)
      pushTicket(r, o, o.customer_id, country, "return_request", ret.requested_at, false);
    if ((draws[5] as number) < 0.012)
      pushTicket(
        r,
        null,
        o.customer_id,
        country,
        "product_question",
        o.placed_at - (0.2 + (offsets[5] as number) * 2) * DAY,
        false,
      );
  }
  tickets.sort((a, b) => a.created_at - b.created_at);
  tickets.forEach((t) => {
    t.id = ticketId++;
  });
  co.tickets.push(...tickets);

  // What the ad platforms report: more conversions than the store counts (view-through), none netted for returns.
  const attributed = new Map<string, { n: number; cents: number }>();
  for (const o of co.orders) {
    if (o.campaign_id === null || o.is_test || o.status === "cancelled" || o.status === "canceled") continue;
    const dayIdx = Math.round((etDate(o.placed_at) - START) / DAY);
    const key = `${o.campaign_id}:${dayIdx}`;
    const cur = attributed.get(key) ?? { n: 0, cents: 0 };
    cur.n += 1;
    cur.cents += toUsd(o.subtotal_cents - o.discount_cents, o.currency, dayIdx);
    attributed.set(key, cur);
  }
  const pr = subRandom(seed, KIND.platform, 0);
  for (const row of co.adSpend) {
    const dayIdx = Math.round((row.spend_date - START) / DAY);
    const a = attributed.get(`${row.campaign_id}:${dayIdx}`);
    const inflate = (row.campaign_id === 11 ? 1.15 : 1.3) * (0.92 + pr.next() * 0.16);
    row.platform_conversions = a ? Math.round(a.n * inflate) : 0;
    row.platform_revenue_cents = a ? Math.round(a.cents * inflate) : 0;
  }

  // Warehouse stock, purchase orders and stockouts.
  inventory(co, seed, asOf, lastDay, linesOf, shippedAt);
}

function inventory(
  co: LumenCompany,
  seed: number,
  asOf: number,
  lastDay: number,
  linesOf: Map<number, LineRow[]>,
  shippedAt: Map<number, number>,
) {
  // Units leaving each warehouse by day, from the shipped orders' item and component lines.
  const demand = new Map<string, number[]>();
  const key = (w: number, v: number) => `${w}:${v}`;
  for (const w of [1, 2]) for (const v of VARIANTS) demand.set(key(w, v.id), new Array(lastDay + 1).fill(0));
  for (const o of co.orders) {
    const at = shippedAt.get(o.id);
    if (at === undefined) continue;
    const i = Math.round((etDate(at) - START) / DAY);
    if (i < 0 || i > lastDay) continue;
    const w = MARKETS[o.ship_country].warehouse;
    for (const l of linesOf.get(o.id) ?? []) {
      if ((l.line_kind === "item" || l.line_kind === "component") && l.variant_id !== null) {
        const series = demand.get(key(w, l.variant_id)) as number[];
        series[i] = (series[i] ?? 0) + l.quantity;
      }
    }
  }
  const [sStart, sEnd] = EVENTS.stockout;
  const freeze = sStart - 66;
  const dateAt = (i: number) => START + i * DAY;
  const lead = 30;
  for (const w of [1, 2]) {
    for (const v of VARIANTS) {
      const p = PRODUCT_BY_ID.get(v.productId) as ProductDef;
      const dem = demand.get(key(w, v.id)) as number[];
      const r = subRandom(seed, KIND.stock, w * 1000 + v.id);
      const unitCost = Math.round(v.usd * p.cost * 100);
      const first = Math.max(0, (p.availableFrom ?? 0) - 25);
      const avg = (from: number, to: number) => {
        let sum = 0;
        let n = 0;
        for (let i = Math.max(0, from); i <= Math.min(lastDay, to); i++) {
          sum += dem[i] as number;
          n++;
        }
        return n === 0 ? 0 : sum / n;
      };
      // Planned on the previous weeks' pace, as a buyer would see it.
      const need = (i: number, days: number) => Math.ceil(Math.max(0.3, avg(i - 28, i - 1)) * days);
      const isTop = v.id === TOP_VARIANT;
      let onHand = Math.ceil(Math.max(1, avg(first, first + 21)) * 70) + r.int(5, 20);
      const incoming: { at: number; qty: number; po: PurchaseOrderRow }[] = [];
      const order = (i: number, qty: number, arrivesOn: number, reason: string | null = null) => {
        const po: PurchaseOrderRow = {
          id: 0,
          warehouse_id: w,
          variant_id: v.id,
          ordered_at: etInstant(i, 10, 0, 0),
          expected_at: dateAt(arrivesOn),
          received_at: null,
          quantity: qty,
          unit_cost_cents: unitCost,
          delay_reason: reason,
        };
        co.purchaseOrders.push(po);
        incoming.push({ at: arrivesOn, qty, po });
        return po;
      };
      for (let i = first; i <= lastDay; i++) {
        if (isTop && i === freeze) {
          // The supplier's port closes: what's on hand lasts to July 6, and what was on its way waits until July 27.
          let units = 0;
          for (let j = i; j < sStart; j++) units += dem[j] as number;
          onHand = units + 3;
          for (const x of incoming) {
            if (x.at > i && x.at <= sEnd) {
              x.at = sEnd + 1;
              x.po.delay_reason = "supplier port closure";
            }
          }
          order(i, Math.max(200, need(i, 70)), sEnd + 1, "supplier port closure").expected_at = dateAt(sStart - 21);
        }
        for (const x of incoming) {
          if (x.at === i) {
            onHand += x.qty;
            x.po.received_at = dateAt(i) + 9 * HOUR <= asOf ? dateAt(i) + 9 * HOUR : null;
          }
        }
        onHand = Math.max(0, onHand - (dem[i] as number));
        if (isTop && i >= sStart && i <= sEnd) onHand = 0;
        if (onHand === 0) co.stockouts.push({ warehouse_id: w, variant_id: v.id, stockout_date: dateAt(i) });
        co.stock.push({ snapshot_date: dateAt(i), warehouse_id: w, variant_id: v.id, on_hand_units: onHand });
        // Reorder when what's on hand and on the way covers less than the lead time plus a fortnight.
        const onTheWay = incoming.filter((x) => x.at > i).reduce((sum, x) => sum + x.qty, 0);
        const frozen = isTop && i >= freeze && i <= sEnd;
        const retired = p.deletedAt !== undefined && i >= p.deletedAt - 40;
        const soon = incoming.some((x) => x.at > i && x.at < i + 14);
        if (!frozen && !retired && !soon && onHand + onTheWay < need(i, lead + 14)) {
          order(i, Math.max(24, need(i, 56)), i + lead + r.int(-3, 4));
        }
      }
    }
  }
  co.purchaseOrders.sort(
    (a, b) => a.ordered_at - b.ordered_at || a.warehouse_id - b.warehouse_id || a.variant_id - b.variant_id,
  );
  co.purchaseOrders.forEach((x, k) => {
    x.id = k + 1;
  });
}

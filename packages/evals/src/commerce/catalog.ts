/** Lumen's static world: its products, bundles, markets, campaigns, discount codes, warehouses and names. */
import { EVENTS } from "./calendar";

export type Currency = "USD" | "EUR" | "GBP" | "CAD";
export type CountryCode = "US" | "CA" | "GB" | "DE" | "FR" | "NL";
export type Category = "lamps" | "pendants" | "candles" | "textiles" | "ceramics" | "smart" | "rugs";

export interface Market {
  currency: Currency;
  /** Shown prices include VAT (EU, UK) or exclude sales tax (US, Canada). */
  taxInclusive: boolean;
  /** The warehouse that ships to it. */
  warehouse: 1 | 2;
  carrier: string;
  /** Standard shipping fee and the order value above which it's free, in the market's cents. */
  shipping: { fee: number; freeFrom: number };
  /** Transit days, from shipment to delivery: [min, max]. */
  transit: [number, number];
  /** Sessions, by country: share of the store's traffic, and a conversion factor. */
  traffic: number;
  cr: number;
  /** Regions and their tax rate in basis points, with their weight. */
  regions: [string | null, number, number][];
}

export const MARKETS: Record<CountryCode, Market> = {
  US: {
    currency: "USD",
    taxInclusive: false,
    warehouse: 1,
    carrier: "NorthPost",
    shipping: { fee: 895, freeFrom: 7500 },
    transit: [3, 6],
    traffic: 0.5,
    cr: 1,
    regions: [
      ["CA", 850, 17],
      ["NY", 875, 9],
      ["TX", 825, 10],
      ["FL", 700, 8],
      ["WA", 1025, 5],
      ["IL", 875, 5],
      ["OR", 0, 3],
      ["MA", 625, 3],
      ["NJ", 663, 3],
      ["CO", 790, 4],
      ["GA", 740, 6],
      ["NC", 700, 5],
      ["OH", 725, 6],
      ["AZ", 840, 4],
      ["VA", 575, 4],
      ["PA", 600, 3],
      ["MN", 810, 3],
    ],
  },
  CA: {
    currency: "CAD",
    taxInclusive: false,
    warehouse: 1,
    carrier: "NorthPost",
    shipping: { fee: 1295, freeFrom: 10000 },
    transit: [5, 9],
    traffic: 0.08,
    cr: 0.92,
    regions: [
      ["ON", 1300, 42],
      ["BC", 1200, 17],
      ["QC", 1498, 18],
      ["AB", 500, 15],
      ["NS", 1500, 4],
      ["MB", 1200, 4],
    ],
  },
  GB: {
    currency: "GBP",
    taxInclusive: true,
    warehouse: 2,
    carrier: "Parcelo",
    shipping: { fee: 595, freeFrom: 6000 },
    transit: [2, 4],
    traffic: 0.13,
    cr: 1.05,
    regions: [[null, 2000, 1]],
  },
  DE: {
    currency: "EUR",
    taxInclusive: true,
    warehouse: 2,
    carrier: "Eurocargo",
    shipping: { fee: 690, freeFrom: 7000 },
    transit: [3, 5],
    traffic: 0.14,
    cr: 0.98,
    regions: [[null, 1900, 1]],
  },
  FR: {
    currency: "EUR",
    taxInclusive: true,
    warehouse: 2,
    carrier: "Eurocargo",
    shipping: { fee: 690, freeFrom: 7000 },
    transit: [3, 5],
    traffic: 0.09,
    cr: 0.9,
    regions: [[null, 2000, 1]],
  },
  NL: {
    currency: "EUR",
    taxInclusive: true,
    warehouse: 2,
    carrier: "Eurocargo",
    shipping: { fee: 690, freeFrom: 7000 },
    transit: [1, 3],
    traffic: 0.06,
    cr: 0.95,
    regions: [[null, 2100, 1]],
  },
};
export const COUNTRY_CODES = Object.keys(MARKETS) as CountryCode[];
/** The share of a USD list price in each currency, before rounding to a price ending in 9. */
export const PRICE_FACTOR: Record<Currency, number> = { USD: 1, CAD: 1.38, GBP: 0.8, EUR: 0.95 };

/** A price that ends in 9 (4 under 40), the way a shop sets them. */
export function priceEnding9(x: number) {
  return x < 40 ? Math.max(4, Math.round((x + 1) / 5) * 5 - 1) : Math.round((x + 1) / 10) * 10 - 1;
}

// -----------------------------------------------------------------------------------------------------------------
// Products

export interface ProductDef {
  id: number;
  name: string;
  line: string;
  category: Category;
  /** The list price in whole US dollars (a variant may override it). */
  usd: number;
  /** Unit cost as a share of the list price. */
  cost: number;
  /** Relative popularity among orders. */
  pop: number;
  /** Chance a unit of it is returned. */
  returnRate: number;
  weightG: number;
  availableFrom?: number;
  deletedAt?: number;
  variants: { option: string; sku: string; share: number; usd?: number }[];
}

export const PRODUCTS: ProductDef[] = [
  {
    id: 1,
    name: "Aurora Table Lamp",
    line: "Aurora",
    category: "lamps",
    usd: 89,
    cost: 0.34,
    pop: 16,
    returnRate: 0.06,
    weightG: 2100,
    variants: [
      { option: "Oak", sku: "AUR-TBL-OAK", share: 0.28 },
      { option: "Matte Black", sku: "AUR-TBL-BLK", share: 0.24 },
      { option: "Brushed Brass", sku: "AUR-TBL-BRS", share: 0.48 },
    ],
  },
  {
    id: 2,
    name: "Aurora Floor Lamp",
    line: "Aurora",
    category: "lamps",
    usd: 189,
    cost: 0.36,
    pop: 5.5,
    returnRate: 0.1,
    weightG: 5400,
    variants: [
      { option: "Matte Black", sku: "AUR-FLR-BLK", share: 0.55 },
      { option: "Brushed Brass", sku: "AUR-FLR-BRS", share: 0.45 },
    ],
  },
  {
    id: 3,
    name: "Aurora Wall Sconce",
    line: "Aurora",
    category: "lamps",
    usd: 119,
    cost: 0.35,
    pop: 5,
    returnRate: 0.07,
    weightG: 1500,
    variants: [
      { option: "Matte Black", sku: "AUR-SCN-BLK", share: 0.5 },
      { option: "Brushed Brass", sku: "AUR-SCN-BRS", share: 0.5 },
    ],
  },
  {
    id: 4,
    name: "Halo Pendant Small",
    line: "Halo",
    category: "pendants",
    usd: 129,
    cost: 0.33,
    pop: 6,
    returnRate: 0.08,
    weightG: 1800,
    variants: [
      { option: "Opal White", sku: "HAL-PS-WHT", share: 0.6 },
      { option: "Smoke", sku: "HAL-PS-SMK", share: 0.4 },
    ],
  },
  {
    id: 5,
    name: "Halo Pendant Large",
    line: "Halo",
    category: "pendants",
    usd: 189,
    cost: 0.33,
    pop: 4,
    returnRate: 0.09,
    weightG: 3200,
    variants: [
      { option: "Opal White", sku: "HAL-PL-WHT", share: 0.58 },
      { option: "Smoke", sku: "HAL-PL-SMK", share: 0.42 },
    ],
  },
  {
    id: 6,
    name: "Halo Cluster",
    line: "Halo",
    category: "pendants",
    usd: 349,
    cost: 0.34,
    pop: 1.4,
    returnRate: 0.11,
    weightG: 6800,
    availableFrom: EVENTS.haloClusterLaunch,
    variants: [{ option: "Smoke", sku: "HAL-CL-SMK", share: 1 }],
  },
  {
    id: 7,
    name: "Ember Soy Candle",
    line: "Ember",
    category: "candles",
    usd: 29,
    cost: 0.27,
    pop: 30,
    returnRate: 0.015,
    weightG: 520,
    variants: [
      { option: "Cedar", sku: "EMB-CND-CED", share: 0.31 },
      { option: "Fig", sku: "EMB-CND-FIG", share: 0.27 },
      { option: "Sea Salt", sku: "EMB-CND-SEA", share: 0.24 },
      { option: "Amber", sku: "EMB-CND-AMB", share: 0.18 },
    ],
  },
  {
    id: 8,
    name: "Ember Taper Set",
    line: "Ember",
    category: "candles",
    usd: 24,
    cost: 0.25,
    pop: 4,
    returnRate: 0.02,
    weightG: 300,
    deletedAt: EVENTS.taperDeleted,
    variants: [{ option: "Ivory, 6 pack", sku: "EMB-TPR-IVR", share: 1 }],
  },
  {
    id: 9,
    name: "Linen Throw",
    line: "Linen",
    category: "textiles",
    usd: 79,
    cost: 0.31,
    pop: 9,
    returnRate: 0.11,
    weightG: 900,
    variants: [
      { option: "Oat", sku: "LIN-THR-OAT", share: 0.42 },
      { option: "Moss", sku: "LIN-THR-MOS", share: 0.31 },
      { option: "Clay", sku: "LIN-THR-CLY", share: 0.27 },
    ],
  },
  {
    id: 10,
    name: "Linen Cushion Cover",
    line: "Linen",
    category: "textiles",
    usd: 34,
    cost: 0.3,
    pop: 11,
    returnRate: 0.1,
    weightG: 280,
    variants: [
      { option: "Oat", sku: "LIN-CSH-OAT", share: 0.4 },
      { option: "Moss", sku: "LIN-CSH-MOS", share: 0.33 },
      { option: "Clay", sku: "LIN-CSH-CLY", share: 0.27 },
    ],
  },
  {
    id: 11,
    name: "Terra Vase",
    line: "Terra",
    category: "ceramics",
    usd: 54,
    cost: 0.32,
    pop: 7,
    returnRate: 0.09,
    weightG: 1300,
    variants: [
      { option: "Sand", sku: "TER-VAS-SND", share: 0.4 },
      { option: "Charcoal", sku: "TER-VAS-CHR", share: 0.33 },
      { option: "Terracotta", sku: "TER-VAS-TRC", share: 0.27 },
    ],
  },
  {
    id: 12,
    name: "Terra Bowl Set",
    line: "Terra",
    category: "ceramics",
    usd: 64,
    cost: 0.33,
    pop: 4,
    returnRate: 0.09,
    weightG: 1900,
    variants: [{ option: "Set of 4, Sand", sku: "TER-BWL-SND", share: 1 }],
  },
  {
    id: 13,
    name: "Spark Smart Bulb 4-Pack",
    line: "Spark",
    category: "smart",
    usd: 39,
    cost: 0.38,
    pop: 8,
    returnRate: 0.05,
    weightG: 360,
    variants: [{ option: "Warm White", sku: "SPK-BLB-4PK", share: 1 }],
  },
  {
    id: 14,
    name: "Spark Dimmer Plug",
    line: "Spark",
    category: "smart",
    usd: 24,
    cost: 0.4,
    pop: 7,
    returnRate: 0.05,
    weightG: 120,
    variants: [{ option: "White", sku: "SPK-PLG-WHT", share: 1 }],
  },
  {
    id: 15,
    name: "Dune Wool Rug",
    line: "Dune",
    category: "rugs",
    usd: 299,
    cost: 0.4,
    pop: 2.6,
    returnRate: 0.2,
    weightG: 9500,
    availableFrom: EVENTS.duneLaunch,
    variants: [
      { option: "5 x 8 ft", sku: "DUN-RUG-58", share: 0.62 },
      { option: "8 x 10 ft", sku: "DUN-RUG-810", share: 0.38, usd: 449 },
    ],
  },
];

export interface VariantDef {
  id: number;
  productId: number;
  option: string;
  sku: string;
  usd: number;
  share: number;
}
export const VARIANTS: VariantDef[] = [];
for (const p of PRODUCTS) {
  for (const v of p.variants) {
    VARIANTS.push({
      id: VARIANTS.length + 1,
      productId: p.id,
      option: v.option,
      sku: v.sku,
      usd: v.usd ?? p.usd,
      share: v.share,
    });
  }
}
export const productOf = (variantId: number) =>
  PRODUCTS.find((p) => p.id === (VARIANTS[variantId - 1] as VariantDef).productId) as ProductDef;
export const variantBySku = (sku: string) => VARIANTS.find((v) => v.sku === sku) as VariantDef;

/** The top seller: the Brushed Brass Aurora Table Lamp, whose stockout is the July 2026 storyline. */
export const TOP_VARIANT = variantBySku("AUR-TBL-BRS").id;
/** The re-SKUed variant: the Oak lamp's SKU changed on EVENTS.reSku. */
export const RESKU_VARIANT = variantBySku("AUR-TBL-OAK").id;
export const RESKU_NEW = "AUR-T1-OAK";

export interface BundleDef {
  id: number;
  name: string;
  sku: string;
  items: { sku: string; quantity: number }[];
}
export const BUNDLES: BundleDef[] = [
  {
    id: 1,
    name: "Cozy Evening Set",
    sku: "BND-COZY",
    items: [
      { sku: "LIN-THR-OAT", quantity: 1 },
      { sku: "EMB-CND-CED", quantity: 1 },
      { sku: "TER-VAS-SND", quantity: 1 },
    ],
  },
  { id: 2, name: "Aurora Duo", sku: "BND-DUO", items: [{ sku: "AUR-TBL-BLK", quantity: 2 }] },
  {
    id: 3,
    name: "Smart Home Starter",
    sku: "BND-SMART",
    items: [
      { sku: "SPK-BLB-4PK", quantity: 2 },
      { sku: "SPK-PLG-WHT", quantity: 1 },
    ],
  },
  {
    id: 4,
    name: "Housewarming Set",
    sku: "BND-HOUSE",
    items: [
      { sku: "EMB-CND-FIG", quantity: 2 },
      { sku: "TER-BWL-SND", quantity: 1 },
      { sku: "LIN-CSH-MOS", quantity: 2 },
    ],
  },
];
/** A bundle's US list price: 12% under its parts. */
export const bundleUsd = (b: BundleDef) =>
  priceEnding9(b.items.reduce((s, i) => s + variantBySku(i.sku).usd * i.quantity, 0) * 0.88);

/** The Halo line's price rise on EVENTS.priceRise: 15% on every variant. */
export const HALO_RISE = 1.15;

// -----------------------------------------------------------------------------------------------------------------
// Marketing

export type Channel = "paid_search" | "paid_social" | "organic_search" | "direct" | "email" | "affiliate";

export interface CampaignDef {
  id: number;
  name: string;
  channel: Channel;
  platform: string | null;
  objective: string;
  /** Traffic by country; omitted means the store's own mix. */
  geo?: Partial<Record<CountryCode, number>>;
  /** Daily budget in whole US dollars at the start of the history (paid), or daily sessions (unpaid). */
  budget: number;
  cpc: number;
  cr: number;
  mobile: number;
  from?: number;
  to?: number;
  /** Product categories this campaign's buyers lean to, as multipliers. */
  tilt?: Partial<Record<Category, number>>;
  /** Multiplier on the chance an order from it is returned. */
  returns?: number;
  /** Paid by commission on sales, not spend. */
  commission?: boolean;
}

export const CAMPAIGNS: CampaignDef[] = [
  {
    id: 1,
    name: "Brand Search",
    channel: "paid_search",
    platform: "google",
    objective: "brand",
    budget: 70,
    cpc: 0.4,
    cr: 0.052,
    mobile: 0.5,
  },
  {
    id: 2,
    name: "Non-brand Lamps",
    channel: "paid_search",
    platform: "google",
    objective: "prospecting",
    budget: 115,
    cpc: 1.1,
    cr: 0.019,
    mobile: 0.52,
    tilt: { lamps: 2, pendants: 1.5 },
  },
  {
    id: 3,
    name: "Non-brand Decor",
    channel: "paid_search",
    platform: "google",
    objective: "prospecting",
    budget: 85,
    cpc: 0.9,
    cr: 0.016,
    mobile: 0.55,
    tilt: { ceramics: 2, textiles: 1.6, candles: 1.4 },
  },
  {
    id: 4,
    name: "Shopping - All Products",
    channel: "paid_search",
    platform: "google",
    objective: "shopping",
    budget: 140,
    cpc: 0.6,
    cr: 0.021,
    mobile: 0.55,
  },
  {
    id: 5,
    name: "Shopping - EU",
    channel: "paid_search",
    platform: "google",
    objective: "shopping",
    budget: 62,
    cpc: 0.52,
    cr: 0.017,
    mobile: 0.56,
    geo: { DE: 0.5, FR: 0.3, NL: 0.2 },
  },
  {
    id: 6,
    name: "Meta Prospecting - Broad",
    channel: "paid_social",
    platform: "meta",
    objective: "prospecting",
    budget: 170,
    cpc: 0.78,
    cr: 0.0125,
    mobile: 0.82,
  },
  {
    id: 7,
    name: "Meta Interests - Home Decor",
    channel: "paid_social",
    platform: "meta",
    objective: "prospecting",
    budget: 100,
    cpc: 0.7,
    cr: 0.0135,
    mobile: 0.84,
    tilt: { candles: 1.6, textiles: 1.4 },
  },
  {
    id: 8,
    name: "TikTok Creator Spark Ads",
    channel: "paid_social",
    platform: "tiktok",
    objective: "awareness",
    budget: 75,
    cpc: 0.48,
    cr: 0.0092,
    mobile: 0.93,
    tilt: { candles: 1.8, smart: 1.5 },
  },
  {
    id: 9,
    name: "Pinterest Shopping",
    channel: "paid_social",
    platform: "pinterest",
    objective: "shopping",
    budget: 55,
    cpc: 0.55,
    cr: 0.012,
    mobile: 0.78,
    tilt: { ceramics: 1.6, textiles: 1.5 },
  },
  {
    id: 10,
    name: "Meta Retargeting - 30 Day",
    channel: "paid_social",
    platform: "meta",
    objective: "retargeting",
    budget: 48,
    cpc: 0.5,
    cr: 0.0105,
    mobile: 0.8,
  },
  {
    id: 11,
    name: "Meta Lookalike - Winter Glow",
    channel: "paid_social",
    platform: "meta",
    objective: "prospecting",
    budget: 150,
    cpc: 0.74,
    cr: 0.0135,
    mobile: 0.85,
    from: EVENTS.winterGlow[0],
    to: EVENTS.winterGlow[1],
    geo: { US: 0.78, CA: 0.1, GB: 0.12 },
    tilt: { rugs: 4.5, lamps: 1.8, pendants: 2.2, candles: 0.3, smart: 0.3, ceramics: 0.6 },
    returns: 7,
  },
  {
    id: 12,
    name: "Home Blog Network",
    channel: "affiliate",
    platform: "impact",
    objective: "affiliate",
    budget: 95,
    cpc: 0,
    cr: 0.021,
    mobile: 0.6,
    commission: true,
  },
  {
    id: 13,
    name: "Coupon Aggregators",
    channel: "affiliate",
    platform: "impact",
    objective: "affiliate",
    budget: 60,
    cpc: 0,
    cr: 0.026,
    mobile: 0.55,
    commission: true,
  },
  {
    id: 14,
    name: "Welcome Flow",
    channel: "email",
    platform: "klaviyo",
    objective: "lifecycle",
    budget: 0,
    cpc: 0,
    cr: 0.05,
    mobile: 0.7,
  },
  {
    id: 15,
    name: "Abandoned Cart",
    channel: "email",
    platform: "klaviyo",
    objective: "lifecycle",
    budget: 55,
    cpc: 0,
    cr: 0.045,
    mobile: 0.7,
  },
  {
    id: 16,
    name: "Weekly Newsletter",
    channel: "email",
    platform: "klaviyo",
    objective: "newsletter",
    budget: 0,
    cpc: 0,
    cr: 0.03,
    mobile: 0.7,
  },
  {
    id: 17,
    name: "Winback Flow",
    channel: "email",
    platform: "klaviyo",
    objective: "lifecycle",
    budget: 0,
    cpc: 0,
    cr: 0.03,
    mobile: 0.7,
  },
];
/** Traffic with no campaign: organic search and direct, as daily sessions at the start of the history. */
export const UNPAID: { channel: Channel; budget: number; cr: number; mobile: number }[] = [
  { channel: "organic_search", budget: 780, cr: 0.016, mobile: 0.64 },
  { channel: "direct", budget: 450, cr: 0.0187, mobile: 0.5 },
];
export const WINTER_GLOW = 11;

export const DISCOUNTS = [
  { id: 1, code: "WELCOME10", kind: "percent", value: 10, from: 0, to: 9999 },
  { id: 2, code: "BF24", kind: "percent", value: 20, from: EVENTS.promo24[0], to: EVENTS.promo24[1] },
  { id: 3, code: "BF25", kind: "percent", value: 25, from: EVENTS.promo25[0], to: EVENTS.promo25[1] },
  { id: 4, code: "SPRING20", kind: "percent", value: 20, from: 0, to: 9999 },
  { id: 5, code: "SUMMER15", kind: "percent", value: 15, from: 0, to: 9999 },
  { id: 6, code: "LOYAL10", kind: "percent", value: 10, from: 0, to: 9999 },
  { id: 7, code: "FREESHIP", kind: "free_shipping", value: 0, from: 0, to: 9999 },
  { id: 8, code: "BF26", kind: "percent", value: 25, from: EVENTS.promo26[0], to: EVENTS.promo26[1] },
] as const;

// -----------------------------------------------------------------------------------------------------------------
// People

export const WAREHOUSES = [
  { id: 1, code: "NJ1", name: "Newark fulfilment", region: "North America" },
  { id: 2, code: "NL1", name: "Rotterdam fulfilment", region: "Europe and UK" },
];

export const FIRST_NAMES = [
  "Maya",
  "Priya",
  "Ines",
  "Sam",
  "Theo",
  "Vera",
  "Bob",
  "Lee",
  "Anna",
  "Jonas",
  "Lena",
  "Marco",
  "Sofia",
  "Daniel",
  "Nora",
  "Felix",
  "Chloe",
  "Oscar",
  "Emma",
  "Liam",
  "Zoe",
  "Hugo",
  "Mia",
  "Noah",
  "Ava",
  "Leo",
  "Ella",
  "Max",
  "Ruby",
  "Finn",
  "Clara",
  "Jules",
  "Iris",
  "Omar",
  "Aisha",
  "Kenji",
  "Mei",
  "Raj",
  "Tara",
  "Diego",
  "Lucia",
  "Pablo",
  "Elise",
  "Arjun",
  "Grace",
  "Henry",
  "Isla",
  "Jack",
  "Kira",
  "Luca",
  "Nina",
  "Owen",
  "Pia",
  "Quinn",
  "Rosa",
  "Sean",
  "Tess",
  "Uma",
  "Victor",
];
export const LAST_NAMES = [
  "Chen",
  "Patel",
  "Costa",
  "Miller",
  "Novak",
  "Larsen",
  "Rossi",
  "Weber",
  "Smith",
  "Garcia",
  "Dubois",
  "Visser",
  "Khan",
  "Brown",
  "Wilson",
  "Taylor",
  "Evans",
  "Clark",
  "Walker",
  "Hall",
  "Young",
  "King",
  "Wright",
  "Baker",
  "Green",
  "Adams",
  "Nelson",
  "Hill",
  "Moore",
  "Reid",
  "Fischer",
  "Meyer",
  "Becker",
  "Schmidt",
  "Martin",
  "Bernard",
  "Petit",
  "Janssen",
  "De Vries",
  "Bakker",
  "Jansen",
  "Mulder",
  "Okafor",
  "Nakamura",
  "Singh",
  "Kowalski",
  "Lindqvist",
  "Ferrari",
  "Silva",
  "Reyes",
];
export const EMAIL_DOMAINS: Record<CountryCode, string[]> = {
  US: ["gmail.com", "gmail.com", "gmail.com", "icloud.com", "outlook.com", "yahoo.com", "proton.me", "hotmail.com"],
  CA: ["gmail.com", "gmail.com", "outlook.com", "yahoo.ca", "icloud.com", "hotmail.com"],
  GB: ["gmail.com", "gmail.com", "outlook.com", "btinternet.com", "icloud.com", "hotmail.co.uk", "yahoo.co.uk"],
  DE: ["gmail.com", "web.de", "gmx.de", "outlook.de", "t-online.de", "icloud.com"],
  FR: ["gmail.com", "orange.fr", "free.fr", "outlook.fr", "icloud.com", "laposte.net"],
  NL: ["gmail.com", "ziggo.nl", "outlook.com", "kpnmail.nl", "icloud.com", "hotmail.nl"],
};
export const WHOLESALE_NAMES = [
  "Harbor & Pine Home",
  "The Corner Atelier",
  "Oakridge Interiors",
  "Nordlicht Wohnen",
  "Maison Verte",
  "Kamer Studio",
  "Brightwater Gifts",
  "Fernhill Living",
  "Copper Door Co",
  "Linden & Lake",
  "Studio Marguerite",
  "The Tallow Shop",
  "Woodland Hearth",
  "Atelier Nord",
  "Rowan Home Store",
  "Salt & Sage Living",
  "Bluebird Boutique",
  "Cedar Lane Goods",
  "Westgate Interiors",
  "Petite Maison",
  "Hearth & Haven",
  "Foxglove Home",
  "Pebble Street Studio",
  "Nest & Nook",
  "Greenwich Lighting Co",
  "Kestrel Home",
  "Alder & Ash",
  "The Lantern Room",
  "Little Fern Gifts",
  "Birchwood Living",
  "Marlow House",
  "Stonebridge Decor",
  "Juniper Row",
  "Coastline Interiors",
  "Haven Street Goods",
  "Tidewater Home",
  "Quill & Candle",
  "Orchard Interiors",
  "Meadow Lane Living",
  "Wren & Willow",
  "Foundry Home",
  "Larkspur Goods",
  "Ivy House Interiors",
  "Northfield Gifts",
  "The Gilded Pine",
  "Saffron Home",
  "Mulberry Lane",
  "Highfield Living",
  "Driftwood & Co",
  "Bellwether Home",
  "Sundial Interiors",
  "Rosewood Lane",
  "Thistle & Thread",
  "Lakeside Lighting",
  "Maple & Moss",
  "Kingfisher Home",
  "Cobble Street Co",
  "Evergreen Interiors",
  "Silverbirch Living",
  "Pennywhistle Goods",
];

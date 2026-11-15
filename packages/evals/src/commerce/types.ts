/**
 * The rows of Lumen's tables, as the generator makes them: snake_case, one field per column. Timestamps are
 * milliseconds since the epoch in fields ending `_at`, and dates are the UTC midnight of the date in fields ending
 * `_date`; the seeder turns them into timestamptz and date values.
 */
import type { CountryCode, Currency } from "./catalog";

export interface FxRow {
  rate_date: number;
  currency: Exclude<Currency, "USD">;
  rate_to_usd: number;
}

export interface CustomerRow {
  id: number;
  email: string;
  first_name: string | null;
  last_name: string | null;
  country: CountryCode;
  is_guest: boolean;
  is_wholesale: boolean;
  company_name: string | null;
  marketing_opt_in: boolean;
  acquisition_channel: string | null;
  created_at: number;
}

export interface AddressRow {
  id: number;
  customer_id: number;
  country: CountryCode;
  region: string | null;
  postal_code: string;
  city: string;
  is_default: boolean;
}

export interface ProductRow {
  id: number;
  name: string;
  product_line: string;
  category: string;
  status: "active" | "discontinued";
  created_at: number;
  deleted_at: number | null;
}

export interface VariantRow {
  id: number;
  product_id: number;
  sku: string;
  option_name: string;
  price_usd_cents: number;
  unit_cost_cents: number;
  weight_g: number;
  is_active: boolean;
  previous_sku: string | null;
  sku_changed_at: number | null;
}

export interface BundleRow {
  id: number;
  name: string;
  sku: string;
  price_usd_cents: number;
}
export interface BundleItemRow {
  bundle_id: number;
  variant_id: number;
  quantity: number;
}

export interface OrderRow {
  id: number;
  number: string;
  customer_id: number;
  order_type: "retail" | "wholesale";
  is_test: boolean;
  placed_at: number;
  currency: Currency;
  ship_country: CountryCode;
  ship_region: string | null;
  status: string;
  cancel_reason: string | null;
  source_channel: string | null;
  campaign_id: number | null;
  device: string | null;
  subtotal_cents: number;
  discount_cents: number;
  shipping_cents: number;
  tax_cents: number;
  tax_rate_bps: number;
  tax_inclusive: boolean;
  gift_card_cents: number;
  total_cents: number;
}

export interface LineRow {
  id: number;
  order_id: number;
  line_kind: "item" | "bundle" | "component" | "gift_card";
  parent_line_id: number | null;
  variant_id: number | null;
  bundle_id: number | null;
  sku: string;
  description: string;
  quantity: number;
  unit_price_cents: number;
  line_total_cents: number;
  discount_cents: number;
}

export interface DiscountRow {
  id: number;
  code: string;
  kind: string;
  percent_off: number;
}
export interface OrderDiscountRow {
  order_id: number;
  discount_id: number;
  applies_to: "merchandise" | "shipping";
  amount_cents: number;
}

export interface GiftCardRow {
  id: number;
  code: string;
  currency: Currency;
  initial_cents: number;
  issued_at: number;
  purchase_order_id: number;
}
export interface RedemptionRow {
  id: number;
  gift_card_id: number;
  order_id: number;
  amount_cents: number;
  redeemed_at: number;
}

export interface PaymentRow {
  id: number;
  order_id: number;
  method: string;
  status: "captured" | "failed" | "voided";
  amount_cents: number;
  currency: Currency;
  created_at: number;
}

export interface ShipmentRow {
  id: number;
  order_id: number;
  warehouse_id: number;
  carrier: string;
  tracking_number: string;
  status: "delivered" | "in_transit";
  shipped_at: number;
  delivered_at: number | null;
}

export interface ReturnRow {
  id: number;
  order_id: number;
  status: "requested" | "received" | "refunded";
  reason: string;
  requested_at: number;
  received_at: number | null;
}
export interface ReturnLineRow {
  id: number;
  return_id: number;
  order_line_id: number;
  quantity: number;
}
export interface RefundRow {
  id: number;
  order_id: number;
  return_id: number | null;
  reason: string;
  amount_cents: number;
  merchandise_cents: number;
  shipping_cents: number;
  tax_cents: number;
  currency: Currency;
  created_at: number;
}

export interface CampaignRow {
  id: number;
  name: string;
  channel: string;
  platform: string | null;
  objective: string;
  is_commission: boolean;
  start_date: number;
  end_date: number | null;
}
export interface AdSpendRow {
  campaign_id: number;
  spend_date: number;
  spend_cents: number;
  impressions: number;
  clicks: number;
  platform_conversions: number;
  platform_revenue_cents: number;
}
export interface SessionRow {
  session_date: number;
  channel: string;
  country: CountryCode;
  device: string;
  sessions: number;
}

export interface WarehouseRow {
  id: number;
  code: string;
  name: string;
  region: string;
}
export interface StockRow {
  snapshot_date: number;
  warehouse_id: number;
  variant_id: number;
  on_hand_units: number;
}
export interface PurchaseOrderRow {
  id: number;
  warehouse_id: number;
  variant_id: number;
  ordered_at: number;
  expected_at: number;
  received_at: number | null;
  quantity: number;
  unit_cost_cents: number;
  delay_reason: string | null;
}
export interface StockoutRow {
  warehouse_id: number;
  variant_id: number;
  stockout_date: number;
}

export interface TicketRow {
  id: number;
  customer_id: number;
  order_id: number | null;
  country: CountryCode;
  category: string;
  channel: string;
  priority: string;
  status: string;
  created_at: number;
  first_response_at: number | null;
  solved_at: number | null;
  csat: number | null;
}

export interface LumenCompany {
  asOf: number;
  fx: FxRow[];
  customers: CustomerRow[];
  addresses: AddressRow[];
  products: ProductRow[];
  variants: VariantRow[];
  bundles: BundleRow[];
  bundleItems: BundleItemRow[];
  discounts: DiscountRow[];
  orders: OrderRow[];
  lines: LineRow[];
  orderDiscounts: OrderDiscountRow[];
  giftCards: GiftCardRow[];
  redemptions: RedemptionRow[];
  payments: PaymentRow[];
  shipments: ShipmentRow[];
  returns: ReturnRow[];
  returnLines: ReturnLineRow[];
  refunds: RefundRow[];
  campaigns: CampaignRow[];
  adSpend: AdSpendRow[];
  sessions: SessionRow[];
  warehouses: WarehouseRow[];
  stock: StockRow[];
  purchaseOrders: PurchaseOrderRow[];
  stockouts: StockoutRow[];
  tickets: TicketRow[];
}

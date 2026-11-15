/**
 * Lumen's guides: rules of this business that change an answer and aren't in the schema, approved and unpinned like
 * Acme's, so the analyst reads one only when its search finds it.
 */
export const LUMEN_GUIDES: { title: string; body: string }[] = [
  {
    title: "How we count revenue",
    body: "Revenue is the merchandise after discounts, in US dollars, without tax, shipping or gift cards. Take VAT out of UK and EU prices (their prices include it) and nothing out of US and Canadian ones (sales tax is added on top). Convert at the rate of the day in New York, from shop.fx_rates. Leave out test orders (is_test), cancelled orders (the status was spelled 'canceled' before June 2025) and wholesale orders (order_type). A gift card sold is not revenue until it's spent, and spending one is a tender (a 'gift_card' payment), not a sale. Refunds come off in the month they're paid.",
  },
  {
    title: "Bundles, units and SKUs",
    body: "A bundle is one order line (line_kind 'bundle') and also its parts as 'component' lines at their share of the bundle's price. Count revenue from item and bundle lines, and units from item and component lines; adding every line counts a bundle twice. Group products by variant_id: the Oak Aurora Table Lamp changed SKU on 1 September 2025, and order lines keep the SKU of their day. Discontinued products are soft-deleted (deleted_at) and keep their orders. The Halo line's prices rose 15% on 10 March 2026, so use the price on the order line, not the current one in variants.",
  },
  {
    title: "Returns, refunds and the reporting day",
    body: "Returns reach us weeks after the order, so a month's refunds are mostly earlier orders' (holiday orders are returned in January). Say whether a figure is by order month or by refund month. Refund amounts: merchandise_cents is as the order showed it, with VAT in the UK and EU; shipping_cents is the shipping refunded; tax_cents the tax in or on top. The store reports in America/New_York: orders.placed_at is UTC, so group days and months by placed_at at time zone 'America/New_York'. One person can be two customers rows (a guest and an account, the email in another case): count people by lower(email).",
  },
];

/**
 * Lumen's glossary: the terms only this business's rules settle, so an analyst that guesses gets them wrong and one
 * that reads the glossary gets them right. `{{shop}}` is the source's shop schema.
 */
export const LUMEN_GLOSSARY: string[] = [
  `term: Net revenue
means: Merchandise sold less merchandise refunded, in US dollars. Merchandise is the lines of retail orders after discounts, without tax (VAT is taken out of UK and EU prices), without shipping and without gift card sales, at the day's rate in shop.fx_rates. Test and cancelled orders and wholesale orders are left out. Refunds count in the month they're paid, not the month of the order.
synonyms: [revenue, net sales, sales, net merchandise revenue]
`,
  `term: Gross merchandise
means: Net revenue before refunds: the merchandise of the orders placed in the period, as above.
synonyms: [gross sales, gross revenue, merchandise sales]
`,
  `term: Order
means: A retail order that was not placed by the team (is_test) and was not cancelled. Both spellings of cancelled count as cancelled (canceled, cancelled). Wholesale orders (order_type = wholesale) are counted separately and never in the store's orders.
synonyms: [orders, valid orders, retail orders]
maps_to:
  column: "{{shop}}.orders.status"
  values: ["processing", "shipped", "fulfilled"]
`,
  `term: Store day
means: The store reports in America/New_York: a day or a month is a New York one. orders.placed_at is UTC, so an evening order in New York is the next UTC day.
synonyms: [reporting day, store month, store time, order date]
`,
  `term: Active customer
means: A person, not a customer row, with at least one order in the 365 days ending on the day asked about. A guest row and an account of the same person (the email in another case) are one person.
synonyms: [active customers, active buyers, live customers]
`,
  `term: Repeat customer
means: A person with two or more orders. A person is a customer by lower(email), across guest and account rows.
synonyms: [repeat customers, returning buyers, repeat buyers]
`,
  `term: New customer
means: An order is a new customer's when it is that person's first order; every later order is a returning customer's. A person is a customer by lower(email).
synonyms: [new customers, first-time buyers, returning customers, new vs returning]
`,
  `term: AOV
means: Average order value: the merchandise of an order after discounts, without tax, shipping and gift card sales, in US dollars, averaged over merchandise orders.
synonyms: [average order value, basket size]
`,
  `term: Units sold
means: Units on item lines plus a bundle's component lines. A bundle's own line is never counted as a unit (its parts already are), and gift cards are not units.
synonyms: [units, items sold, units shipped]
`,
  `term: Conversion rate
means: Merchandise orders divided by sessions for the same New York days (marketing.daily_sessions). Gift card purchases are not counted as orders here.
synonyms: [conversion, CR, sessions to orders]
`,
  `term: ROAS
means: Return on ad spend: the merchandise of the orders credited to a campaign (orders.campaign_id), in US dollars, over its spend. Net ROAS takes off the merchandise refunded on those orders, whenever the refund was paid. The ad platforms' own reported revenue is a platform claim, never the store's.
synonyms: [return on ad spend, net ROAS, ROAS net of returns]
`,
  `term: Refund rate
means: Merchandise refunded in a month divided by merchandise sold in the same month, both without tax and in US dollars. It's by refund date: January's refunds are mostly December's orders.
synonyms: [return rate, refund share]
`,
  `term: Top SKU
means: The variant with the most merchandise revenue over the period asked about (at list price, before discounts), by variant_id: the Aurora Table Lamp in Brushed Brass over the last year. Units sold is a different ranking (a candle leads it). A re-SKUed variant is still one variant.
synonyms: [best seller, top seller, top product, flagship SKU]
`,
  `term: Stockout day
means: A day a variant had no stock in a warehouse (inventory.stockout_days). A variant out in both warehouses on a day is one day.
synonyms: [out of stock days, stockouts]
`,
];

/** The glossary for a source whose shop schema is `shopSchema`. */
export const lumenGlossary = (shopSchema = "shop") => LUMEN_GLOSSARY.map((t) => t.replaceAll("{{shop}}", shopSchema));

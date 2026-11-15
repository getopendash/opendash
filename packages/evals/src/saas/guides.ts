/**
 * The demo company's guides that only search finds (DashBench's search subset, measuring vectors): rules of this
 * business that change an answer, approved and unpinned, so they're never in the analyst's prompt; the analyst reads
 * one only when its `context_search` finds it. Each question in the subset is worded without the guide's own words
 * ("clients who walked away" for lost customers), so finding the guide by its words is harder than finding it by its
 * meaning: that's the lift being measured.
 */
export const DEMO_GUIDES: { title: string; body: string }[] = [
  {
    title: "How we count lost customers",
    body: "A lost customer is an account that canceled a paid subscription in the period and has no other subscription still active, paused or in trial. A subscription canceled during its trial, or the moment its trial ended, was never paid and never counts; neither do test accounts. Count accounts, not subscriptions.",
  },
  {
    title: "Large contracts",
    body: "A large contract is a subscription billed at least 1,000 a month in its own currency (USD, EUR or GBP, never converted), at its list price: an annual plan's amount divided by 12, before any discount. Test accounts never count. Asked how many in a period, count the subscriptions that started in it.",
  },
  {
    title: "Account health",
    body: "An account is healthy when it has an active subscription and no urgent support ticket still open or pending. Paused or trialing subscriptions don't make an account healthy, and test accounts are left out.",
  },
];

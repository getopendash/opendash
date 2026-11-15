/**
 * What a model call costs: each allowlisted model's list price (ai/catalog.ts, where each price's
 * source and date are), worked out when the call is made and stored on its usage_event, so a later price change
 * never rewrites a past call. A model without a price has an unknown cost, never zero.
 */
import { type ModelPrice, priceOf } from "../ai/catalog";

export type { ModelPrice };

/** Where the catalog's prices come from, and as of when. */
export const PRICE_SOURCES = [
  {
    makers: "Anthropic",
    url: "https://platform.claude.com/docs/en/about-claude/pricing",
    asOf: "2026-10-10",
  },
  { makers: "OpenAI and Google", url: "https://ai-gateway.vercel.sh/v1/models", asOf: "2026-10-20" },
] as const;

export interface CallTokens {
  /** Input tokens neither read from nor written to the cache. */
  noCacheTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

/** A call's cost in USD, rounded to 6 decimals (as usage_event.cost_usd holds it), or null for a model without a price. */
export function costOf(model: string, t: CallTokens): number | null {
  const listed = priceOf(model);
  if (!listed) return null;
  const prompt = t.noCacheTokens + t.cacheReadTokens + t.cacheWriteTokens;
  const p = listed.above && prompt > listed.above.inputTokens ? listed.above.price : listed;
  const usd =
    (t.noCacheTokens * p.input +
      t.cacheReadTokens * p.cacheRead +
      t.cacheWriteTokens * p.cacheWrite +
      t.outputTokens * p.output) /
    1_000_000;
  return Math.round(usd * 1e6) / 1e6;
}

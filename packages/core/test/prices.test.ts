// What a model call costs (usage/prices.ts): every kind of token at its own price, rounded as usage_event keeps it, a
// bigger prompt's price for the whole call where a model has one, and no price (never zero) for a model without one.
// Spend limits add these up, so each case is worked out by hand.
import { describe, expect, it } from "vitest";
import { CATALOG } from "../src/ai/catalog";
import { costOf } from "../src/usage/prices";

const none = { noCacheTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };

describe("a model call's cost", () => {
  it("prices each kind of token by the million", () => {
    expect(costOf("claude-sonnet-5-5", { ...none, noCacheTokens: 1_000_000 })).toBe(2);
    expect(costOf("claude-sonnet-5-5", { ...none, cacheReadTokens: 1_000_000 })).toBe(0.1);
    expect(costOf("claude-sonnet-5-5", { ...none, cacheWriteTokens: 1_000_000 })).toBe(2.5);
    expect(costOf("claude-sonnet-5-5", { ...none, outputTokens: 1_000_000 })).toBe(10);
    // A typical step: 12k fresh, 30k from the cache, 2k written to it, 800 out.
    expect(
      costOf("claude-sonnet-5-5", {
        noCacheTokens: 12_000,
        cacheReadTokens: 30_000,
        cacheWriteTokens: 2_000,
        outputTokens: 800,
      }),
    ).toBe(0.04);
  });

  it("rounds to a millionth of a dollar, as it's stored", () => {
    expect(costOf("claude-haiku-5-5", { ...none, outputTokens: 1 })).toBe(0.000001);
    expect(costOf("claude-haiku-5-5", { ...none, noCacheTokens: 3 })).toBe(0);
  });

  it("charges a prompt over Haiku's threshold the higher price for the whole call", () => {
    const at = (prompt: number) => costOf("claude-haiku-5-5", { ...none, noCacheTokens: prompt, outputTokens: 1_000 });
    // 100,000 is at the line, not over it.
    expect(at(100_000)).toBe(0.0105);
    expect(at(100_001)).toBe(0.052501);
    // Cache reads and writes count toward the prompt's size.
    expect(
      costOf("claude-haiku-5-5", { ...none, noCacheTokens: 50_000, cacheReadTokens: 60_000, outputTokens: 0 }),
    ).toBe(0.028);
  });

  it("has no price for a model it doesn't list, never a free one", () => {
    expect(costOf("some-other-model", { ...none, noCacheTokens: 1_000 })).toBeNull();
    const prices = CATALOG.flatMap((m) => (m.price ? [m.price] : []));
    expect(prices.every((p) => p.input > 0 && p.output > 0)).toBe(true);
  });
});

// A cache miss, and why: each call should read back what the call before it left in the cache; less
// than that, by more than a block's rounding, is a miss put down to a fold, a wait past the cache's life, or nothing
// known ("unexplained", the one to look into).
import { describe, expect, it } from "vitest";
import { cacheMissOf } from "../src/harness/commit";

const usage = (read: number, written: number) => ({
  usage: { inputTokenDetails: { cacheReadTokens: read, cacheWriteTokens: written } },
});
const scope = () => ({
  run: { id: "r" } as never,
  log: () => {},
  lastCache: undefined as { tokens: number; at: number } | undefined,
  prefixBroke: undefined as "folded" | undefined,
});

describe("a cache miss", () => {
  it("isn't one when the call reads back what the last left, or more", () => {
    const s = scope();
    expect(cacheMissOf(s, usage(0, 20_000), 0)).toBeNull();
    expect(cacheMissOf(s, usage(20_000, 1_500), 1_000)).toBeNull();
    expect(cacheMissOf(s, usage(21_000, 800), 2_000)).toBeNull();
  });

  it("is put down to a fold when the prefix changed", () => {
    const s = scope();
    cacheMissOf(s, usage(0, 30_000), 0);
    s.prefixBroke = "folded";
    expect(cacheMissOf(s, usage(4_000, 9_000), 1_000)).toEqual({ lostTokens: 26_000, cause: "folded" });
  });

  it("is put down to the wait when the cache's life passed", () => {
    const s = scope();
    cacheMissOf(s, usage(0, 30_000), 0);
    expect(cacheMissOf(s, usage(0, 31_000), 6 * 60_000)).toEqual({ lostTokens: 30_000, cause: "idle" });
  });

  it("is unexplained otherwise", () => {
    const s = scope();
    cacheMissOf(s, usage(0, 30_000), 0);
    expect(cacheMissOf(s, usage(2_000, 29_000), 10_000)).toEqual({ lostTokens: 28_000, cause: "unexplained" });
  });
});

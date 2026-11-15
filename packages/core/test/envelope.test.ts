import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { dekAad, generateDek, localKek } from "../src/crypto/envelope";

const kek = localKek(randomBytes(32).toString("base64"));

describe("envelope encryption", () => {
  it("wraps and unwraps a DEK", async () => {
    const dek = generateDek();
    const wrapped = await kek.wrap(dek, dekAad("org-a", 1));
    expect(await kek.unwrap(wrapped, dekAad("org-a", 1))).toEqual(dek);
  });

  it("fails to unwrap a DEK moved to another org or version", async () => {
    const wrapped = await kek.wrap(generateDek(), dekAad("org-a", 1));
    await expect(kek.unwrap(wrapped, dekAad("org-b", 1))).rejects.toThrow();
    await expect(kek.unwrap(wrapped, dekAad("org-a", 2))).rejects.toThrow();
  });

  it("refuses a wrapped key that's truncated, padded or not 32 bytes", async () => {
    const wrapped = Buffer.from(await kek.wrap(generateDek(), dekAad("org-a", 1)), "base64");
    for (const bad of [wrapped.subarray(0, wrapped.length - 12), Buffer.concat([wrapped, Buffer.alloc(4)])]) {
      await expect(kek.unwrap(bad.toString("base64"), dekAad("org-a", 1))).rejects.toThrow(/wrong length/);
    }
    await expect(kek.wrap(new Uint8Array(16), dekAad("org-a", 1))).rejects.toThrow(/32 bytes/);
  });

  it("rejects a KEK of the wrong size", () => {
    expect(() => localKek(randomBytes(16).toString("base64"))).toThrow(/32 bytes/);
  });
});

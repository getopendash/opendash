import { describe, expect, it } from "vitest";
import { keyHeaderLine } from "@/lib/key-header";

describe("keyHeaderLine", () => {
  it("says what a call sends, with the key hidden", () => {
    expect(keyHeaderLine("Authorization", "Token {key}")).toBe("Authorization: Token ••••");
    expect(keyHeaderLine("X-API-Key", "{key}")).toBe("X-API-Key: ••••");
  });

  it("reads a server from before formats the way it was sent", () => {
    expect(keyHeaderLine(null, null)).toBe("Authorization: Bearer ••••");
    expect(keyHeaderLine("x-api-key", null)).toBe("x-api-key: ••••");
  });
});

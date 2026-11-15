// What a provider said, as a provider's test shows it (said.ts): its words from each provider's error shape, none from
// an HTML page, and never a key, whether the one tested or one shaped like a key.
import { describe, expect, it } from "vitest";
import { readFailure, redact, toldBy, wordsIn } from "../src/providers/said";

describe("a provider's words", () => {
  it("are read from each provider's error shape", () => {
    expect(wordsIn({ error: { message: "Rate limit reached for requests" } })).toBe("Rate limit reached for requests");
    expect(wordsIn({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } })).toBe(
      "invalid x-api-key",
    );
    expect(wordsIn({ error: "No auth credentials found" })).toBe("No auth credentials found");
    expect(wordsIn({ Message: "The security token included in the request is invalid." })).toBe(
      "The security token included in the request is invalid.",
    );
    expect(wordsIn('{"message":"Model not found"}')).toBe("Model not found");
    expect(wordsIn("Upstream connect error")).toBe("Upstream connect error");
  });

  it("aren't an HTML page or an empty body", () => {
    expect(wordsIn("<html><body>502 Bad Gateway</body></html>")).toBeNull();
    expect(wordsIn("")).toBeNull();
    expect(wordsIn({})).toBeNull();
  });

  it("never carry a key, and stay short", () => {
    const tested = "given-key-given-key-given-key";
    expect(redact(`Key ${tested} has no access`, [tested])).toBe("Key … has no access");
    expect(redact("Bad key vck_0000given0000given0000", [])).toBe("Bad key …");
    expect(redact("Unknown AKIAIOSFODNN7EXAMPLE", [])).toBe("Unknown …");
    expect(redact("Sent Bearer abc.def.ghi-jkl", [])).toBe("Sent …");
    expect(redact("Key AIzaSyA-0123456789abcdefghij is invalid", [])).toBe("Key … is invalid");
    expect(redact("x".repeat(400), [])).toHaveLength(300);
  });
});

describe("a failed call, for a person", () => {
  it("says the provider's words with its status, the body before the SDK's message", () => {
    const error = Object.assign(new Error("Forbidden"), {
      statusCode: 403,
      responseBody: '{"error":{"message":"Your organization must be verified to use this model."}}',
    });
    expect(toldBy("OpenAI", readFailure(error, [], 30_000))).toBe(
      "OpenAI said (403): Your organization must be verified to use this model.",
    );
  });

  it("says ours only when the provider gave no words, or never answered", () => {
    expect(toldBy("Anthropic", { status: 403, words: null })).toBe("Anthropic answered 403 without saying why.");
    expect(toldBy("Anthropic", { status: 402, words: null })).toBe(
      "Anthropic says the account has no credit left (402).",
    );
    const late = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    expect(toldBy("OpenRouter", readFailure(late, [], 15_000))).toBe(
      "Couldn't reach OpenRouter: no answer within 15 s.",
    );
  });
});

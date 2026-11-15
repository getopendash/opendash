// What a failed model call means: a busy provider is retried, a refused key or an empty account fails at
// once, and a prompt too long is folded and sent once more. Read from the error alone, never logged.
import { APICallError, RetryError } from "ai";
import { describe, expect, it } from "vitest";
import { ModelStalled } from "../src/harness/model";
import { readModelError } from "../src/harness/model-errors";

const api = (statusCode: number, message: string, responseBody?: string) =>
  new APICallError({
    message,
    url: "https://api.example.com/v1/messages",
    requestBodyValues: {},
    statusCode,
    ...(responseBody ? { responseBody } : {}),
  });

describe("a failed model call", () => {
  it("is busy when the provider is overloaded, rate limited or unreachable", () => {
    expect(readModelError(api(529, "Overloaded")).kind).toBe("busy");
    expect(readModelError(api(429, "Rate limit reached for requests")).kind).toBe("busy");
    // A rate limit that points at billing is still a rate limit; only the provider's quota code means no credit.
    expect(readModelError(api(429, "Too many requests. See your plan and billing page for limits.")).kind).toBe("busy");
    expect(readModelError(api(503, "Service unavailable")).kind).toBe("busy");
    expect(readModelError(new TypeError("fetch failed")).kind).toBe("busy");
    // After the SDK's own retries, the last attempt's error says what it was.
    const retried = new RetryError({
      message: "Failed after 3 attempts",
      reason: "maxRetriesExceeded",
      errors: [api(529, "Overloaded")],
    });
    expect(readModelError(retried)).toEqual({ kind: "busy", status: 529 });
  });

  it("stalled when its stream went quiet", () => {
    expect(readModelError(new ModelStalled("The model's response went quiet for 90 s.")).kind).toBe("stalled");
    expect(readModelError(Object.assign(new Error("aborted"), { cause: new ModelStalled("quiet") })).kind).toBe(
      "stalled",
    );
  });

  it("too long when the prompt doesn't fit, whatever the provider calls it", () => {
    expect(readModelError(api(400, "prompt is too long: 214123 tokens > 200000 maximum")).kind).toBe("too_long");
    expect(readModelError(api(400, "Bad request", '{"error":{"code":"context_length_exceeded"}}')).kind).toBe(
      "too_long",
    );
    expect(readModelError(api(413, "Request too large")).kind).toBe("too_long");
  });

  it("a key or billing problem never retries, even as a 429", () => {
    expect(readModelError(api(401, "invalid x-api-key"))).toEqual({ kind: "key", status: 401 });
    expect(readModelError(api(403, "Forbidden")).kind).toBe("key");
    expect(
      readModelError(api(429, "You exceeded your current quota, please check your plan and billing details.")).kind,
    ).toBe("billing");
    expect(readModelError(api(400, "Your credit balance is too low to access the API.")).kind).toBe("billing");
  });

  it("a bad request is one retrying can't fix", () => {
    expect(readModelError(api(400, "messages: text content blocks must be non-empty")).kind).toBe("bad_request");
    expect(readModelError(api(404, "model: not_found")).kind).toBe("bad_request");
  });
});

// Search v0's words: where each kind of hit opens.
import { describe, expect, it } from "vitest";
import { hitHref, KIND_LABEL } from "../lib/search-words";

describe("search hits", () => {
  it("open their own page", () => {
    expect(hitHref({ kind: "metric", id: "m1", connectionId: "c1" })).toBe("/knowledge/metrics/m1");
    expect(hitHref({ kind: "term", id: "t1", connectionId: null })).toBe("/knowledge/glossary/t1");
    expect(hitHref({ kind: "verified_query", id: "v1", connectionId: "c1" })).toBe("/knowledge/verified/v1");
    expect(hitHref({ kind: "table", id: "o1", connectionId: "c1" })).toBe("/data/sources/c1/catalog?table=o1");
    expect(KIND_LABEL.term).toBe("glossary term");
  });
});

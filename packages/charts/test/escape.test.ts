// The chart tooltip is HTML that ECharts renders, built from data: what goes into it is escaped.
import { describe, expect, it } from "vitest";
import { escapeHtml } from "../src";

describe("chart tooltip text", () => {
  it("escapes markup that came from the data", () => {
    expect(escapeHtml(`<img src=x onerror="alert(1)">`)).toBe("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(escapeHtml("Tom & Jerry's plan")).toBe("Tom &amp; Jerry&#39;s plan");
  });
});

// An answer's text on the page: never HTML, and no link in it ever followed (it's the model's writing, steered by the
// data it read; a link could carry that to someone else's site): its text, the address beside it when it differs.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

const { AnswerText } = await import("../components/ask/answer-text");
const draw = (text: string) => renderToStaticMarkup(createElement(AnswerText, { segments: [{ text }], scope: "t" }));

describe("an answer's text on the page", () => {
  it("draws no link to follow, and no HTML, whatever the answer says", () => {
    const html = draw(
      "See [the report](https://elsewhere.test/?q=secret), https://opendash.example and [bad](javascript:alert(1)). <img src=x onerror=alert(1)>",
    );
    expect(html).not.toContain("<a");
    expect(html).not.toContain("<img");
    expect(html).toContain("the report");
    expect(html).toContain("(https://elsewhere.test/?q=secret)");
    // A bare address is its own text, once; a target that isn't http(s) or mailto isn't shown as one.
    expect(html.split("https://opendash.example").length - 1).toBe(1);
    expect(html).not.toContain("javascript:");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
});

// The answer's draft: the only path from a streaming draft to the screen. It's drawn as the checked answer is, so the
// answer lands where it was, and no figure shows before the gate checked it: every reference, a reference still being
// written, and any number typed outside one, wherever the markdown puts it, is a pill.
import type { AnswerSegment } from "@opendash/core";
import { REF_CLOSE, REF_OPEN } from "@opendash/markdown";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CARET, draftPieces, draftSource } from "../lib/answer-draft";

const { AnswerDraft } = await import("../components/ask/answer-draft");
const { AnswerText } = await import("../components/ask/answer-text");

const PILL = /<span class="draft-pill[^"]*"><\/span>/g;
const draw = (draft: string, held = false) => renderToStaticMarkup(createElement(AnswerDraft, { draft, held }));
/** What a person reads: tags gone, a pill ▢, the caret |, the note under the draft left out. */
const read = (draft: string, held = false) =>
  draw(draft, held)
    .replace(/<p class="text-small[^"]*">[^<]*<\/p>/, "")
    .replace(PILL, "▢")
    .replace(/<span class="draft-caret[^"]*"[^>]*><\/span>/g, "|")
    .replace(/<br\/>/g, "\n")
    .replace(/<\/(p|li|tr|th|td)>/g, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

describe("an answer's draft", () => {
  it("shows every reference as a pill", () => {
    expect(read("MRR was ⟦q1:0:mrr|currency:USD⟧, up ⟦pct(q1:0:mrr, q1:1:mrr)⟧.", true)).toBe("MRR was ▢, up ▢.");
  });

  it("hides a reference still being written, and whatever came after its ⟦", () => {
    expect(read("MRR was ⟦q1:0:m")).toBe("MRR was ▢|");
    expect(read("⟦q1")).toBe("▢|");
  });

  it("never shows a number typed outside a reference, in any form", () => {
    expect(read("It fell 12.5% to $412,600 (−3k), about 1.2M in 2026.", true)).toBe(
      "It fell ▢ to ▢ (▢), about ▢ in ▢.",
    );
    // Digits in a word too: the gate checks them, so the draft never shows one it might refuse.
    expect(read("Bookings grew 3x to €5bn, up 12pp; churn 5bps; $1.2bn; USD1,234; 40hrs", true)).toBe(
      "Bookings grew ▢x to ▢, up ▢pp; churn ▢bps; ▢; USD▢; ▢hrs",
    );
    expect(read("Q3 plans", true)).toBe("Q▢ plans");
  });

  it("shows no digit wherever the markdown puts one: code, links, list numbers, tables, entities", () => {
    const draft = [
      "## Top 3 plans",
      "Run `select 42` or see [page 7](https://example.test/r/2026?id=9).",
      "```\nlimit 100\n```",
      "3. third\n4. fourth",
      "| Plan | Seats |\n| --- | ---: |\n| Pro 2 | 120 |",
      "Entity &#49; and ⟦q1:0:mrr⟧ and **bold 5** too",
    ].join("\n\n");
    const html = draw(draft);
    // Tags and class names carry digits of their own (h-3.5): what's read can't.
    expect(read(draft)).not.toMatch(/\d/);
    expect(html).not.toContain("start=");
    expect(html).not.toContain("example.test");
    expect(html).toContain("<table");
    expect(html).toContain("<ol");
    expect(html).toContain("<pre");
  });

  it("shows no numeral an entity decodes to, nor any other script's digits", () => {
    expect(read("Revenue grew &frac12; and &#xFF11;&#xFF12;%, then ² and Ⅻ and ١٢", true)).toBe(
      "Revenue grew ▢ and ▢, then ▢ and ▢ and ▢",
    );
  });

  it("puts the caret in the parsed draft, so it never changes what the markdown is", () => {
    expect(draw("| Plan | Seats |\n| --- | --- |\n")).toContain("<table");
    expect(draw("| Plan | Seats |\n| --- | --- |")).toContain("<table");
    expect(read("Revenue\n===")).toBe("Revenue|");
    expect(read("```\nselect\n```")).toBe("select|");
    expect(read("> ```sql\n> select name\n> ```")).toBe("select name|");
    expect(read("## Plans ##")).toBe("Plans|");
    expect(draw("**Summary:**")).toContain("<strong>Summary:</strong>");
    expect(draw("**Open `code`**")).toContain("<strong>Open <code");
    // A dash is a list item being started: the caret goes in it.
    expect(draw("Plans:\n- ")).toMatch(/<ul[^>]*><li><span class="draft-caret/);
  });

  it("is drawn as its checked answer is, so the answer lands in its place with only the numbers changed", () => {
    const draft = "You have **⟦q2:0:n⟧ subscriptions**.\n\n### By plan\n\n- **Starter**: ⟦q1:0:n⟧\n- Growth: ⟦q1:1:n⟧";
    const ref = (r: string, display: string): AnswerSegment => ({ ref: r, display, kind: "number", citations: [] });
    const checked = renderToStaticMarkup(
      createElement(AnswerText, {
        scope: "answer",
        segments: [
          { text: "You have **" },
          ref("q2:0:n", "1,197"),
          { text: " subscriptions**.\n\n### By plan\n\n- **Starter**: " },
          ref("q1:0:n", "772"),
          { text: "\n- Growth: " },
          ref("q1:1:n", "354"),
        ],
      }),
    );
    const shape = (html: string) =>
      html
        .replace(/<button[^>]*>[^<]*<\/button>/g, "#")
        .replace(PILL, "#")
        .replace(/<span class="draft-caret[^"]*"[^>]*><\/span>/g, "");
    const drafted = draw(draft, true).replace(/<p class="text-small[^"]*">[^<]*<\/p>/, "");
    expect(shape(drafted)).toBe(`<div class="flex flex-col gap-2" aria-busy="true">${shape(checked)}</div>`);
  });

  it("doesn't show half-written markdown's marks, and leaves finished markdown as it is", () => {
    // A bold or code mark still open is hidden until it closes.
    expect(read("You have **Starter")).toBe("You have Starter|");
    expect(read("You have **")).toBe("You have |");
    expect(read("Run `select")).toBe("Run select|");
    // A table shows once it parses as one, not as a line of pipes.
    expect(read("By plan:\n\n| Plan | Active |")).toBe("By plan:|");
    expect(draw("By plan:\n\n| Plan | Active |\n| --- | -")).toContain("<table");
    expect(draw("| Plan | Active |\n| --- | ---: |\n| Starter | ⟦q1:0")).toContain("<table");
    // Nothing is added to markdown that's whole: code with marks in it, escapes, a rule, a fence with a pipe in it.
    expect(read("Run `select ** from plans`.", true)).toBe("Run select ** from plans.");
    expect(read("Run ``a ` b`` now", true)).toBe("Run a ` b now");
    expect(read("The *`plan`* field is available.", true)).toBe("The plan field is available.");
    expect(read("Use \\` to quote **bold**.", true)).toBe("Use ` to quote bold.");
    expect(draw("***", true)).toContain("<hr");
    expect(draw("***")).toContain("<hr");
    expect(read("```text\nfirst\n\n|\n```", true)).toBe("first\n\n|".replace(/\s+/g, " "));
  });

  it("is still while it's held: no caret, and it says what's happening", () => {
    const html = draw("MRR was ⟦q1:0:mrr⟧.", true);
    expect(html).not.toContain("draft-caret");
    expect(html).toContain("Fixing what the check found");
    expect(draw("MRR was ⟦q1:0:mrr⟧.")).toContain("draft-caret");
  });
});

describe("the draft's source and pieces", () => {
  it("puts every reference, and one still being written, as a placeholder", () => {
    expect(draftSource("MRR ⟦q1:0:mrr⟧ and ⟦q1:1:m")).toBe(`MRR ${REF_OPEN}0${REF_CLOSE} and ${REF_OPEN}1${REF_CLOSE}`);
    expect(draftSource("MRR ⟦q1:0:mrr⟧.\n\n")).toBe(`MRR ${REF_OPEN}0${REF_CLOSE}.\n\n`);
  });

  it("splits a text into words, pills and the caret", () => {
    expect(draftPieces(`up ${REF_OPEN}0${REF_CLOSE} from 12${CARET}`)).toEqual([
      { kind: "text", text: "up " },
      { kind: "pill" },
      { kind: "text", text: " from " },
      { kind: "pill" },
      { kind: "caret" },
    ]);
  });
});

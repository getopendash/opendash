// An answer's markdown read the CommonMark way (GFM tables and strikethrough): its blocks and inline parts; nothing
// ever HTML, a link's target only http(s) or mailto; references kept as the caller's placeholders, inside marks and
// table cells; where it reads differently from the hand-written readers it replaced, the reading we keep; and which
// of a table's columns hold numbers.
import { describe, expect, it } from "vitest";
import {
  numericColumns,
  parseMarkdown,
  plainText,
  REF_CLOSE,
  REF_OPEN,
  safeHref,
  takeTable,
  visibleLinks,
} from "../src";

const ref = (i: number) => `${REF_OPEN}${i}${REF_CLOSE}`;
const text = (t: string) => ({ kind: "text", text: t });
const para = (...content: unknown[]) => ({ kind: "paragraph", content });

describe("an answer's markdown", () => {
  it("reads paragraphs, a list under a lead-in line, numbered lists from their first number, and a table", () => {
    expect(parseMarkdown("One.\nStill one.\n\nTwo.")).toEqual([para(text("One.\nStill one.")), para(text("Two."))]);
    expect(parseMarkdown("Split by:\n- plan\n- country\n\n3. third\n4. fourth")).toEqual([
      para(text("Split by:")),
      { kind: "list", start: null, items: [[para(text("plan"))], [para(text("country"))]] },
      { kind: "list", start: 3, items: [[para(text("third"))], [para(text("fourth"))]] },
    ]);
    expect(parseMarkdown(`Accounts by month:\n| Month | New |\n|---|---:|\n| July | ${ref(0)} |`)).toEqual([
      para(text("Accounts by month:")),
      {
        kind: "table",
        align: [null, "right"],
        head: [[text("Month")], [text("New")]],
        rows: [[[text("July")], [text(ref(0))]]],
      },
    ]);
    expect(parseMarkdown("| not a table")).toEqual([para(text("| not a table"))]);
  });

  it("reads bold, italics, code, struck text, nested lists, headings, code blocks and quotes", () => {
    expect(parseMarkdown(`It is **concentrated** in ${ref(1)}: \`q4\`, *mostly*, ~~not~~ \\*literal\\*.`)).toEqual([
      para(
        text("It is "),
        { kind: "bold", children: [text("concentrated")] },
        text(` in ${ref(1)}: `),
        { kind: "code", text: "q4" },
        text(", "),
        { kind: "italic", children: [text("mostly")] },
        text(", "),
        { kind: "struck", children: [text("not")] },
        text(" *literal*."),
      ),
    ]);
    expect(parseMarkdown("- a\n  - b\n- c")).toEqual([
      {
        kind: "list",
        start: null,
        items: [[para(text("a")), { kind: "list", start: null, items: [[para(text("b"))]] }], [para(text("c"))]],
      },
    ]);
    expect(parseMarkdown("## Top movers\n```\nselect 1\n```\n> A **quote**")).toEqual([
      { kind: "heading", depth: 2, content: [text("Top movers")] },
      { kind: "code", text: "select 1" },
      { kind: "quote", children: [para(text("A "), { kind: "bold", children: [text("quote")] })] },
    ]);
    // A column name's underscores stay; CommonMark reads a*b*c as italics, and only "1." starts a list mid-paragraph.
    expect(plainText((parseMarkdown("churned_mrr and a*b*c")[0] as unknown as { content: never[] }).content)).toBe(
      "churned_mrr and abc",
    );
    expect(parseMarkdown("We grew.\n2. Not a list")).toEqual([para(text("We grew.\n2. Not a list"))]);
  });

  it("never reads anything as HTML, and follows a link only to http(s) or mailto", () => {
    expect(parseMarkdown("Use <b>this</b><script>alert(1)</script>")).toEqual([
      para(
        text("Use "),
        text("<b>"),
        text("this"),
        text("</b>"),
        text("<script>"),
        text("alert(1)"),
        text("</script>"),
      ),
    ]);
    expect(parseMarkdown("<div onclick=x>block</div>")).toEqual([para(text("<div onclick=x>block</div>"))]);
    expect(
      parseMarkdown("![chart](https://x.test/c.png) [bad](javascript:alert(1)) [ok](https://opendash.example/a)"),
    ).toEqual([
      para(text("chart"), text(" "), { kind: "link", href: null, children: [text("bad")] }, text(" "), {
        kind: "link",
        href: "https://opendash.example/a",
        children: [text("ok")],
      }),
    ]);
    expect([safeHref("mailto:a@b.test"), safeHref("data:text/html,x"), safeHref("not a url")]).toEqual([
      "mailto:a@b.test",
      null,
      null,
    ]);
  });

  it("leaves no link that hides where it goes, however it's written, for Slack", () => {
    expect(visibleLinks("See [the report](https://elsewhere.test/?q=secret) and https://opendash.example.")).toBe(
      "See the report (https://elsewhere.test/?q=secret) and https://opendash.example.",
    );
    // What a pattern would miss: a reference link and its definition, parentheses in an address, an address in angle
    // brackets with a space, a label over two lines, nested brackets, an image, Slack's own <url|text>.
    expect(visibleLinks("Read [this][1].\n\n[1]: https://x.test/a?d=1")).toBe("Read this (https://x.test/a?d=1).\n\n");
    expect(visibleLinks("[wiki](https://x.test/a_(b))")).toBe("wiki (https://x.test/a_(b))");
    expect(visibleLinks("[go](<https://x.test/a b>)")).toBe("go (https://x.test/a b)");
    expect(visibleLinks("[two\nlines](https://x.test/2)")).toBe("two lines (https://x.test/2)");
    expect(visibleLinks("[a [b] c](https://x.test/3)")).toBe("a [b] c (https://x.test/3)");
    expect(visibleLinks("![chart](https://x.test/c.png)")).toBe("chart (https://x.test/c.png)");
    expect(visibleLinks("<https://x.test/y|click>")).toBe("click (https://x.test/y)");
    // Slack's own syntax, which CommonMark doesn't read: a label with spaces, a bare <url>, a mention left to quiet().
    expect(visibleLinks("Go <https://e.test/?q=s|click here> or <https://e.test/plain> now.")).toBe(
      "Go click here (https://e.test/?q=s) or https://e.test/plain now.",
    );
    expect(visibleLinks("<mailto:a@b.test|mail us> and `<https://x.test|kept>`")).toBe(
      "mail us (mailto:a@b.test) and `<https://x.test|kept>`",
    );
    // One link written out mustn't leave another whole: nested, and whatever's left starting with "<" is defused.
    const nested = visibleLinks("<https://x.test/?q=secret|<https://e.test|click>>");
    expect(nested).not.toMatch(/<[^\u2060\s]/);
    expect(nested).toContain("https://x.test/?q=secret");
    expect(visibleLinks("a <b> c")).toBe("a <\u2060b> c");
    // A reference or definition no parser here took as one, broken up the same way.
    expect(visibleLinks("x [a][b] y, and see [c]: d")).toBe("x [a] [b] y, and see [c] : d");
    // A definition the parser does take goes, its address shown where it's used.
    expect(visibleLinks("- [c]: https://x.test/d")).toBe("- ");
    // Link syntax no parser here took as a link is broken up; code is left as written.
    expect(visibleLinks("odd ](https://x.test) and `[k](v)`")).toBe("odd ] (https://x.test) and `[k](v)`");
  });
});

describe("an answer's first table, taken out", () => {
  it("cuts it where the parser found it, the words around it as written, its cells as text as wide as its header", () => {
    const source =
      "There are **2** plans:\n\n| Plan | Accounts |\n|:--|--:|\n| **Growth** | 12 |\n| [Scale](https://x.example) |\n\nGrowth _leads_.";
    expect(takeTable(source)).toEqual({
      before: "There are **2** plans:",
      after: "Growth _leads_.",
      align: ["left", "right"],
      head: ["Plan", "Accounts"],
      rows: [
        ["Growth", "12"],
        ["Scale", ""],
      ],
    });
  });

  it("takes only the first, at the top: one in a list, a quote or code stays where it is", () => {
    const second = "| A |\n|---|\n| 1 |\n\n| B |\n|---|\n| 2 |";
    expect(takeTable(second)).toMatchObject({ before: "", head: ["A"], after: "| B |\n|---|\n| 2 |" });
    expect(takeTable("- list:\n\n  | A |\n  |---|\n  | 1 |")).toBeNull();
    expect(takeTable("> | A |\n> |---|\n> | 1 |")).toBeNull();
    expect(takeTable("```\n| A |\n|---|\n| 1 |\n```")).toBeNull();
    expect(takeTable("No table, 2 plans.")).toBeNull();
  });
});

describe("a table's columns of numbers", () => {
  it("are those whose every cell is a number or a reference, or that the markdown aligns right", () => {
    const head = ["Month", "New accounts", "Change", "Note"];
    const rows = [
      ["July 2026", ref(0), "+12%", "steady"],
      ["August", ref(1), "$1.2k", "a dip"],
    ];
    expect(numericColumns({ align: [null, null, null, null], head, rows })).toEqual([false, true, true, false]);
    expect(numericColumns({ align: [null, null, null, "right"], head, rows })).toEqual([false, true, true, true]);
    expect(numericColumns({ align: [null], head: ["Empty"], rows: [] })).toEqual([false]);
  });
});

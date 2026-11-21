// An answer drawn as a PDF: its blocks with the caller's note; its markdown read the page's way
// (@opendash/markdown): tables (a column of numbers aligned right), lists (numbered ones with their numbers, nested ones
// a step in), headings, code and quotes, bold and code drawn without their marks, a reference in bold; a file name
// that's never the raw title; and a real PDF laid out by react-pdf in the package's own fonts, a Noto font for each
// script Geist lacks, onto more pages when it's long, two at once.
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { type Answer, answerBlocks, pdfFileName, renderPdf, textBlocks } from "../src";

const cell = (row: number) => ({ alias: "q1", queryRunId: "qr1", row, column: "churned_mrr" });
const answer = (markdown: unknown[], verified = true): Answer =>
  ({
    kind: "answer",
    status: "answered",
    verified,
    rendered: "",
    segments: { markdown, interpretation: [[{ text: "September 2026" }]], caveats: [] },
  }) as unknown as Answer;
const names = new Map([["qr1", { alias: "q1", title: "Churned MRR by month" }]]);

describe("an answer's PDF", () => {
  it("lays it out under the caller's note, saying when something couldn't be verified", () => {
    const at = { organization: "Acme", answeredAt: "2026-10-11T09:00:00Z", question: "Why?", names };
    const blocks = answerBlocks(
      answer([
        { text: "Churned MRR fell to " },
        { ref: "q1:1:churned_mrr", display: "$9.8k", kind: "number", citations: [cell(1)] },
        { text: "." },
      ]),
      { ...at, note: "Asked in Slack." },
    );
    expect(blocks.map((b) => b.kind)).toEqual(["head", "title", "note", "chips", "paragraph", "trace"]);
    expect(blocks[0]).toEqual({ kind: "head", organization: "Acme", answeredAt: "Oct 11, 2026" });
    expect(blocks[2]).toEqual({ kind: "note", text: "Asked in Slack." });
    const unverified = answerBlocks(answer([{ text: "It fell." }], false), { ...at, note: "Asked in Slack." });
    expect(unverified[2]).toEqual({ kind: "note", text: "Asked in Slack. Some of it couldn't be verified." });
  });

  it("draws its title and headline figures above its text, a table a group, and traces their numbers", () => {
    const at = {
      organization: "Acme",
      answeredAt: "2026-10-11T09:00:00Z",
      question: "Why?",
      names,
      note: "From OpenDash.",
    };
    const ref = (display: string, row: number) => ({
      ref: `q1:${row}:churned_mrr`,
      display,
      kind: "number",
      citations: [cell(row)],
    });
    const blocks = answerBlocks(
      {
        ...answer([{ text: "It fell." }]),
        title: "Churn at a glance",
        figures: [
          {
            label: "Churned MRR",
            value: [ref("$9.8k", 1)],
            change: { segments: [ref("-12%", 0)], direction: "down" },
            vs: "vs August",
            trend: {
              label: "By month",
              points: [0, 1].map((row) => ({ value: row, display: `$${row}k`, cell: cell(row) })),
            },
          },
          { label: "Starter", value: [ref("$4.1k", 2)], group: "By plan" },
        ],
      } as unknown as Answer,
      at,
    );
    expect(blocks.map((b) => b.kind)).toEqual([
      "head",
      "title",
      "note",
      "chips",
      "heading",
      "table",
      "paragraph",
      "table",
      "paragraph",
      "trace",
    ]);
    const table = blocks[5] as { rows: { text: string }[][][] };
    expect(table.rows[0]?.map((c) => c.map((r) => r.text).join(""))).toEqual([
      "Churned MRR",
      "$9.8k",
      "▼ -12% vs August",
      "By month: $0k · $1k",
    ]);
    const trace = blocks.at(-1) as { rows: { figure: string; cell: string }[] };
    expect(trace.rows.map((r) => r.figure)).toEqual(["$9.8k", "-12%", "$4.1k", "$0k · $1k"]);
    expect(trace.rows.at(-1)?.cell).toBe("rows 1, 2 · churned_mrr");
  });

  it("draws a markdown table and list as a table and a list, not a line of pipes", () => {
    const r = (text: string, style = "regular") => ({ text, style });
    expect(
      textBlocks([
        { text: "Starter fell most.\n\n| Plan | Sept |\n|---|---|\n| Starter | " },
        { ref: "q1:0:churned_mrr", display: "$4.1k", kind: "number", citations: [cell(0)] },
        { text: " |\n| Growth | $3.6k |\n\n- Scale was flat\n- Growth too" },
      ] as never),
    ).toEqual([
      { kind: "paragraph", runs: [r("Starter fell most.")] },
      {
        kind: "table",
        header: [[r("Plan")], [r("Sept")]],
        // A reference is its display, in bold, as the page shows a traced number.
        rows: [
          [[r("Starter")], [r("$4.1k", "bold")]],
          [[r("Growth")], [r("$3.6k")]],
        ],
        // A column of numbers (a reference among them) to the right, as the page aligns it.
        align: ["left", "right"],
      },
      {
        kind: "list",
        items: [
          { marker: "•", depth: 0, runs: [r("Scale was flat")] },
          { marker: "•", depth: 0, runs: [r("Growth too")] },
        ],
      },
    ]);
  });

  it("reads the answer's markdown as the page does, and draws it without its marks", async () => {
    const [para] = textBlocks([
      { text: "It is **concentrated**: the top three make `7.4k`, the *rest* a long tail. 5 * 3 stays." },
    ] as never);
    expect(para).toEqual({
      kind: "paragraph",
      runs: [
        { text: "It is ", style: "regular" },
        { text: "concentrated", style: "bold" },
        { text: ": the top three make ", style: "regular" },
        { text: "7.4k", style: "code" },
        { text: ", the rest a long tail. 5 * 3 stays.", style: "regular" },
      ],
    });
    // A heading, a code block, a quote and anything tag-shaped, as text; nothing dropped.
    expect(textBlocks([{ text: "## Top\n```\nselect 1\n```\n> Note <b>this</b>" }] as never)).toEqual([
      { kind: "heading", runs: [{ text: "Top", style: "regular" }] },
      { kind: "code", text: "select 1" },
      { kind: "paragraph", runs: [{ text: "Note <b>this</b>", style: "regular" }], quote: true },
    ]);
    // A hard line break is a line break, as on the page.
    expect(textBlocks([{ text: "First line  \nsecond" }] as never)).toEqual([
      { kind: "paragraph", runs: [{ text: "First line\nsecond", style: "regular" }] },
    ]);
  });

  it("keeps a numbered list's numbers, from its first, and a nested list a step in", () => {
    const item = (marker: string, depth: number, text: string) => ({
      marker,
      depth,
      runs: [{ text, style: "regular" }],
    });
    // (In CommonMark only a list from 1 starts straight under a line: one from 3 needs the blank line before it.)
    expect(
      textBlocks([{ text: "Two groups:\n\n3. Warehouse work\n4. Delivery\n   - damaged parcels" }] as never),
    ).toEqual([
      { kind: "paragraph", runs: [{ text: "Two groups:", style: "regular" }] },
      {
        kind: "list",
        items: [item("3.", 0, "Warehouse work"), item("4.", 0, "Delivery"), item("•", 1, "damaged parcels")],
      },
    ]);
  });

  it("names its file by a slug of the title", () => {
    expect(pdfFileName("Why did churn drop in September?")).toBe("why-did-churn-drop-in-september.pdf");
    expect(pdfFileName('"; rm -rf /')).toBe("rm-rf.pdf");
    expect(pdfFileName("???")).toBe("report.pdf");
  });

  it("draws a PDF in its own fonts, beyond Latin-1, onto more pages when it's long", async () => {
    const long = Array.from({ length: 60 }, (_, i) => ({
      text: `Paragraph ${i}: growth slowed to −$10 a month → still ≥ the floor. ${"More words to fill the line. ".repeat(6)}\n\n`,
    }));
    const bytes = await renderPdf(
      answerBlocks(answer(long), {
        organization: "Acme",
        answeredAt: "2026-10-11T09:00:00Z",
        question: "Long",
        note: "A note.",
        names,
      }),
      "Long",
    );
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe("%PDF-");
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThan(1);
    expect(doc.getTitle()).toBe("Long");
  });

  it("draws each script in a font that has it, emoji in the emoji font, and two PDFs at once", async () => {
    const text = "Greek Ελληνικά, Arabic العربية, Hebrew עברית, Hindi हिन्दी, Thai ภาษาไทย, ✓ done ✅ 🚀, `code`.";
    const [one, two] = await Promise.all(
      [text, `${text} Again.`].map((t) => renderPdf(textBlocks([{ text: t }] as never), "Scripts")),
    );
    // Font names are written in the clear (glyphs aren't): each font that drew something is embedded, by name.
    const fonts = new Set(
      Buffer.from(one ?? [])
        .toString("latin1")
        .match(/\/BaseFont \/[A-Z]+\+[\w-]+/g),
    );
    const names = [...fonts].map((f) => f.replace(/.*\+/, "")).sort();
    expect(names).toEqual([
      "Geist-Regular",
      "GeistMono-Regular",
      "NotoEmoji-Regular",
      "NotoSans-Regular",
      "NotoSansArabic-Regular",
      "NotoSansDevanagari-Regular",
      "NotoSansHebrew-Regular",
      "NotoSansSymbols2-Regular",
      "NotoSansThai-Regular",
    ]);
    expect((await PDFDocument.load(two ?? new Uint8Array())).getTitle()).toBe("Scripts");
  });

  it("lays a long table onto more pages, its numbers aligned right", async () => {
    const rows = Array.from({ length: 90 }, (_, i) => `| Month ${i} | ${i * 1000} |`).join("\n");
    const [table] = textBlocks([{ text: `| Month | Value |\n|---|---|\n${rows}` }] as never);
    expect(table).toMatchObject({ kind: "table", align: ["left", "right"] });
    const doc = await PDFDocument.load(await renderPdf([table as never], "Table"));
    expect(doc.getPageCount()).toBeGreaterThan(1);
  });
});

// An answer as a card in Slack: its first table as Slack's own table where it was in the text, up to two charts as
// Slack's own charts after it, the words as today's markdown (quieted, links in sight) and never rewritten. Only for a
// checked answer with something Slack can draw; percentages scaled to what their labels say; a chart Slack can't
// draw as the page does (a gap, too many points, labels it can't tell apart) stays an image; anything the adapter
// would degrade means no card.
import type { ResolvedChart, RunOutcome } from "@opendash/core";
import { describe, expect, it } from "vitest";
import { answerCard, chartMessages, hundredfold, nativeChart, shorten, TABLE_PAGE } from "../src/card";

type Ref = { ref: string; display: string; kind: "text"; citations: [] };
/** A reference as the gate leaves it in the segments: what it shows. */
const ref = (display: string): Ref => ({ ref: "q1:0:x", display, kind: "text", citations: [] });

/** An answer as the gate leaves it: `parts` its text in segments (a string is text, `ref(…)` a reference). */
const answer = (text: string | (string | Ref)[], over: Record<string, unknown> = {}): RunOutcome => {
  const parts = typeof text === "string" ? [text] : text;
  const markdown = parts.map((p): { text: string } | Ref => (typeof p === "string" ? { text: p } : p));
  const rendered = markdown.map((p) => ("ref" in p ? p.display : p.text)).join("");
  return {
    kind: "answer",
    status: "answered",
    verified: true,
    path: "unmodelled",
    markdown: "",
    rendered,
    interpretation: [],
    caveats: [],
    citations: [{ queryRunId: "q-run-1" }],
    values: [],
    problems: [],
    segments: { markdown, caveats: [], interpretation: [] },
    ...over,
  } as unknown as RunOutcome;
};

const chart = (over: Partial<ResolvedChart> = {}, values: (number | null)[] = [12, 7]): ResolvedChart => ({
  type: "bar",
  title: "Accounts by plan",
  horizontal: false,
  axis: { compact: true },
  categories: ["Growth", "Scale"].slice(0, values.length),
  series: [
    {
      name: "Accounts",
      points: values.map((value, row) =>
        value === null
          ? null
          : { value, display: String(value), cell: { alias: "q1", queryRunId: "q-run-1", row, column: "accounts" } },
      ),
    },
  ],
  ...over,
});

const TABLE = "| Plan | Accounts |\n|---|---:|\n| Growth | 12 |\n| Scale | 7 |";

describe("an answer's card", () => {
  it("draws its first table as Slack's own, where it was, the words around it as they were written", () => {
    const card = answerCard(
      answer(`There are **2** plans:\n\n${TABLE}\n\nGrowth leads.`, {
        interpretation: ["All plans"],
        caveats: ["Trials left out."],
      }),
    );
    expect(card?.charts).toEqual([]);
    // How it read the question and its caveats go under it, as for every answer (`replyBlocks`).
    expect(card?.blocks.map((b) => b.type)).toEqual(["markdown", "data_table", "markdown"]);
    const [before, table, after] = card?.blocks ?? [];
    expect(before?.text).toBe("There are **2** plans:");
    expect(after?.text).toBe("Growth leads.");
    // Its cells as written (raw text, so nothing in them is markup), a page of them at a time.
    expect(table).toMatchObject({ type: "data_table", page_size: 2 });
    expect(JSON.stringify(table)).not.toContain("|");
    expect(((table?.rows ?? []) as { text: string }[][]).map((r) => r.map((c) => c.text))).toEqual([
      ["Plan", "Accounts"],
      ["Growth", "12"],
      ["Scale", "7"],
    ]);
  });

  it("starts with the table when the answer does, and pages a long one", () => {
    const rows = Array.from({ length: 30 }, (_, i) => `| Plan ${i} | ${i} |`).join("\n");
    const card = answerCard(answer(`| Plan | Accounts |\n|---|---:|\n${rows}`));
    expect(card?.blocks.map((b) => b.type)).toEqual(["data_table"]);
    expect(card?.blocks[0]?.page_size).toBe(TABLE_PAGE);
  });

  it("names its asker first when the thread holds someone else's conversation too", () => {
    const address = (md: string) => `<@UPRIYA> ${md}`;
    expect(answerCard(answer(`Here:\n\n${TABLE}`), address)?.blocks[0]?.text).toBe("<@UPRIYA> Here:");
    expect(answerCard(answer(TABLE), address)?.blocks[0]).toEqual({ type: "markdown", text: "<@UPRIYA> " });
  });

  it("reads the table with each value a placeholder: a value with a pipe stays in its cell", () => {
    const card = answerCard(answer(["| Plan | Accounts |\n|---|---:|\n| ", ref("Growth | 7"), " | ", ref("12"), " |"]));
    const [table] = card?.blocks ?? [];
    expect(((table?.rows ?? []) as { text: string }[][]).map((r) => r.map((c) => c.text))).toEqual([
      ["Plan", "Accounts"],
      ["Growth | 7", "12"],
    ]);
  });

  it("puts each value back in the words as the gate showed it, quieted", () => {
    const card = answerCard(answer(["MRR is ", ref("$48.2k"), " for ", ref("<!channel>"), ":\n\n", TABLE]));
    // As today's message says it: the mention broken up (an invisible joiner after the `<`), so it notifies nobody.
    expect(card?.blocks[0]?.text).toMatch(/^MRR is \$48\.2k for /);
    expect(card?.blocks[0]?.text).not.toContain("<!channel>");
  });

  it("leaves a table in the words when plain cells couldn't say what its cells do", () => {
    // Struck text, a link (even one whose words hold a pipe), two marked numbers that would run together.
    expect(answerCard(answer("| Plan | Accounts |\n|---|---|\n| Growth | ~~12~~ **14** |"))).toBeNull();
    expect(answerCard(answer("| Plan | Docs |\n|---|---|\n| Growth | [guide](https://docs.example/g) |"))).toBeNull();
    expect(
      answerCard(
        answer(["| Plan | Accounts |\n|---|---:|\n| [Growth\\|Scale](https://x.example) | ", ref("12"), " |"]),
      ),
    ).toBeNull();
    expect(
      answerCard(answer(["| Plan | Accounts |\n|---|---|\n| Growth | **", ref("12"), "**_", ref("14"), "_ |"])),
    ).toBeNull();
    // A bare address, and a number next to words, read the same as plain text.
    const fine = answerCard(answer("| Plan | Docs |\n|---|---|\n| **12** plans | https://docs.example/g |"));
    expect(((fine?.blocks[0]?.rows ?? []) as { text: string }[][])[1]?.map((c) => c.text)).toEqual([
      "12 plans",
      "https://docs.example/g",
    ]);
  });

  it("is today's message when a link uses a definition, or the text holds a placeholder's own characters", () => {
    expect(answerCard(answer(`See [the guide][g].\n\n${TABLE}\n\n[g]: https://docs.example/g`))).toBeNull();
    expect(answerCard(answer(TABLE, { caveats: ["See [g].\n\n[g]: https://docs.example/g"] }))).toBeNull();
    expect(answerCard(answer(["`\uE0000\uE001` ", ref("12"), `\n\n${TABLE}`]))).toBeNull();
    // Written as entities, which the parse turns into a placeholder's characters.
    expect(answerCard(answer(["&#xE000;0&#xE001; ", ref("12"), `\n\n${TABLE}`]))).toBeNull();
    expect(answerCard(answer(["&#57344;0&#57345; ", ref("12"), `\n\n${TABLE}`]))).toBeNull();
  });

  it("keeps an indented block after the table indented", () => {
    const card = answerCard(answer(`${TABLE}\n\n    # not a heading`));
    expect(card?.blocks[1]?.text).toBe("    # not a heading");
  });

  it("keeps text that looks like an emoji code as written, in cells and titles", () => {
    const card = answerCard(
      answer("| Plan | Note |\n|---|---|\n| Growth | {{emoji:bulb}} |", {
        charts: [chart({ title: "Ideas {{emoji:bulb}}" })],
      }),
    );
    expect(JSON.stringify(card?.blocks)).not.toContain(":bulb:");
    expect(JSON.stringify(card?.blocks)).toContain("{{emoji:bulb}}");
  });

  it("is today's message for an older answer with no segments to read its table from", () => {
    expect(answerCard(answer(TABLE, { segments: undefined, charts: [chart()] }))).toBeNull();
  });

  it("quiets mentions and shows every link's address, in the words and in the cells", () => {
    const card = answerCard(
      answer(`Tell <!channel> and [the team](https://evil.example/x):\n\n| Who | N |\n|---|---|\n| <!here> @ops | 3 |`),
    );
    const [words, table] = card?.blocks ?? [];
    expect(words?.text).not.toContain("<!channel>");
    expect(words?.text).toContain("the team (https://evil.example/x)");
    const cell = ((table?.rows ?? []) as { text: string }[][])[1]?.[0]?.text ?? "";
    expect(cell).not.toContain("<!here>");
    expect(cell).toContain("@⁠ops");
  });

  it("draws up to two charts as Slack's own after the words; the rest stay images", () => {
    const card = answerCard(
      answer("Accounts by plan, three ways.", {
        charts: [chart(), chart({ title: "Accounts again" }), chart({ title: "A third" })],
      }),
    );
    expect(card?.charts).toEqual([0, 1]);
    expect(card?.blocks.map((b) => b.type)).toEqual(["markdown", "data_visualization", "data_visualization"]);
    expect(card?.blocks[1]).toMatchObject({
      type: "data_visualization",
      title: "Accounts by plan",
      chart: {
        type: "bar",
        axis_config: { categories: ["Growth", "Scale"] },
        series: [
          {
            name: "Accounts",
            data: [
              { label: "Growth", value: 12 },
              { label: "Scale", value: 7 },
            ],
          },
        ],
      },
    });
  });

  it("leaves a second chart whose title reads the same once cut as an image", () => {
    const long = "Monthly recurring revenue by plan and by region, ";
    const card = answerCard(
      answer("Before and after.", {
        charts: [chart({ title: `${long}before discounts` }), chart({ title: `${long}after discounts` })],
      }),
    );
    expect(card?.charts).toEqual([0]);
  });

  it("skips a chart Slack can't draw as the page does, and takes the next", () => {
    const many = Array.from({ length: 21 }, (_, i) => i);
    const card = answerCard(
      answer("Charts.", {
        charts: [
          chart({}, [12, null]),
          chart({ categories: many.map((i) => `Plan ${i}`) }, many),
          chart({ title: "This one fits" }),
        ],
      }),
    );
    expect(card?.charts).toEqual([2]);
  });

  it("is a card for an answer that didn't pass every check too: what was checked says so under it", () => {
    const card = answerCard(answer(TABLE, { verified: false, problems: ["A number isn't from a query."] }));
    expect(card?.blocks.map((b) => b.type)).toEqual(["data_table"]);
  });

  it("is today's message for an answer that couldn't answer, has no numbers or nothing to draw", () => {
    const drawable = { charts: [chart()] };
    expect(answerCard(answer(TABLE, { status: "cannot_answer", ...drawable }))).toBeNull();
    expect(answerCard(answer(TABLE, { citations: [] }))).toBeNull();
    expect(answerCard(answer("Just words, 2 plans."))).toBeNull();
    expect(answerCard({ kind: "no_answer", reason: "No data." } as RunOutcome)).toBeNull();
    expect(answerCard(null)).toBeNull();
    // A table in a list or a quote stays in the words; one past Slack's rows does too.
    expect(answerCard(answer(`- Plans:\n\n  ${TABLE.replaceAll("\n", "\n  ")}`))).toBeNull();
    const rows = Array.from({ length: 100 }, (_, i) => `| Plan ${i} | ${i} |`).join("\n");
    expect(answerCard(answer(`| Plan | Accounts |\n|---|---:|\n${rows}`))).toBeNull();
    // Too long for one message.
    expect(answerCard(answer(`${"Long. ".repeat(2_000)}\n\n${TABLE}`))).toBeNull();
  });
});

describe("an answer's other charts", () => {
  it("are Slack's own, two a message, after the card's; the ones Slack can't draw are images", () => {
    const many = Array.from({ length: 21 }, (_, i) => i);
    const charts = [
      chart({ title: "One" }),
      chart({ title: "Two" }),
      chart({ title: "Three" }),
      chart({ title: "Gap" }, [12, null]),
      chart({ title: "Long", categories: many.map((i) => `Plan ${i}`) }, many),
      chart({ title: "Four" }),
      chart({ title: "Five" }),
    ];
    const outcome = answer("Charts.", { charts });
    expect(answerCard(outcome)?.charts).toEqual([0, 1]);
    const after = chartMessages(outcome, [0, 1]);
    expect(after.messages.map((m) => m.charts)).toEqual([[2, 5], [6]]);
    expect(after.messages.map((m) => m.blocks.map((b) => b.type))).toEqual([
      ["data_visualization", "data_visualization"],
      ["data_visualization"],
    ]);
    expect(after.images).toEqual([3, 4]);
    // With no card (an answer too long for one message, say), every chart Slack can draw goes this way.
    expect(chartMessages(outcome, []).messages.flatMap((m) => m.charts)).toEqual([0, 1, 2, 5, 6]);
  });
});

describe("a chart as Slack's own", () => {
  it("shows a percentage as its labels do, and names the currency on the axis", () => {
    const pct = nativeChart(chart({ axis: { percent: true, compact: false } }, [0.061, 0.1234]));
    expect(pct).toMatchObject({
      chart: { yLabel: "%", series: [{ values: [6.1, 12.34] }] },
    });
    const usd = nativeChart(chart({ axis: { currency: "USD", compact: true } }, [1234.567, 99]));
    expect(usd).toMatchObject({ chart: { yLabel: "USD", series: [{ values: [1234.567, 99] }] } });
  });

  it("stands a chart drawn on its side up, its bars and values the same", () => {
    expect(nativeChart(chart({ horizontal: true }))).toEqual(nativeChart(chart()));
  });

  it("never rounds a value away: a tiny share stays above zero, a cent boundary as it is", () => {
    const tiny = nativeChart(chart({ axis: { percent: true, compact: false } }, [0.000001, 0.07]));
    expect(tiny).toMatchObject({ chart: { series: [{ values: [0.0001, 7] }] } });
    const close = nativeChart(chart({ axis: { percent: true, compact: false } }, [0.1234999999999, 0.1235000000001]));
    const [a, b] = (close?.chart as { series: { values: number[] }[] } | undefined)?.series[0]?.values ?? [];
    expect(a).toBeLessThan(12.35);
    expect(b).toBeGreaterThan(12.35);
    const edge = nativeChart(chart({ axis: { percent: true, compact: false } }, [0.12349999999999997, 0.1235]));
    const [x, y] = (edge?.chart as { series: { values: number[] }[] } | undefined)?.series[0]?.values ?? [];
    expect(x).toBeLessThan(12.35);
    expect(y).toBe(12.35);
    const cents = nativeChart(chart({ axis: { currency: "USD", compact: false } }, [1.005, 2]));
    expect(cents).toMatchObject({ chart: { series: [{ values: [1.005, 2] }] } });
  });

  it("cuts a long title and labels to Slack's length, unless that makes two labels the same", () => {
    const long = nativeChart(
      chart({ title: "Accounts by plan over the whole of the last financial year", categories: ["A", "B"] }),
    );
    expect(String(long?.title).length).toBeLessThanOrEqual(50);
    expect(long?.title).toMatch(/…$/);
    const cut = nativeChart(chart({ categories: ["Enterprise North America", "Enterprise South America"] }));
    expect(cut?.chart).toMatchObject({ categories: ["Enterprise North Am…", "Enterprise South Am…"] });
    expect(nativeChart(chart({ categories: ["Enterprise customers one", "Enterprise customers two"] }))).toBeNull();
  });

  it("moves a number's decimal point two places, so values that differ still differ", () => {
    expect([0.07, 0.000001, 5, -0.5, 12.3456, 0.1235].map(hundredfold)).toEqual([7, 0.0001, 500, -50, 1234.56, 12.35]);
    expect(hundredfold(1e-21)).toBeCloseTo(1e-19, 30);
  });

  it("cuts text never inside a character", () => {
    expect(shorten("📈".repeat(30), 20)).toBe(`${"📈".repeat(9)}…`);
    expect(shorten("  Spaces   in\nit ", 50)).toBe("Spaces in it");
  });
});

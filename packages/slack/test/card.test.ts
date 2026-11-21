// An answer as a card in Slack: its first table as Slack's own table where it was in the text, up to two charts as
// Slack's own charts after it, the words as today's markdown (quieted, links in sight) and never rewritten. Only for a
// checked answer with something Slack can draw; percentages scaled to what their labels say; a chart Slack can't
// draw as the page does (a gap, too many points, labels it can't tell apart) stays an image; anything the adapter
// would degrade means no card.
import type { ResolvedChart, RunOutcome } from "@opendash/core";
import { describe, expect, it } from "vitest";
import { answerCard, nativeChart, shorten, TABLE_PAGE } from "../src/card";

const answer = (rendered: string, over: Record<string, unknown> = {}): RunOutcome =>
  ({
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
    ...over,
  }) as unknown as RunOutcome;

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
    expect(card?.blocks.map((b) => b.type)).toEqual(["markdown", "data_table", "markdown", "markdown"]);
    const [before, table, after, tail] = card?.blocks ?? [];
    expect(before?.text).toBe("There are **2** plans:");
    expect(after?.text).toBe("Growth leads.");
    expect(tail?.text).toBe("_All plans_\n\n> Trials left out.");
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

  it("is today's message for an answer that didn't pass, couldn't answer, has no numbers or nothing to draw", () => {
    const drawable = { charts: [chart()] };
    expect(answerCard(answer(TABLE, { verified: false, ...drawable }))).toBeNull();
    expect(answerCard(answer(TABLE, { problems: ["A number isn't from a query."], ...drawable }))).toBeNull();
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

describe("a chart as Slack's own", () => {
  it("shows a percentage as its labels do, and names the currency on the axis", () => {
    const pct = nativeChart(chart({ axis: { percent: true, compact: false } }, [0.061, 0.1234]));
    expect(pct).toMatchObject({
      chart: { yLabel: "%", series: [{ values: [6.1, 12.34] }] },
    });
    const usd = nativeChart(chart({ axis: { currency: "USD", compact: true } }, [1234.567, 99]));
    expect(usd).toMatchObject({ chart: { yLabel: "USD", series: [{ values: [1234.57, 99] }] } });
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

  it("cuts text never inside a character", () => {
    expect(shorten("📈".repeat(30), 20)).toBe(`${"📈".repeat(9)}…`);
    expect(shorten("  Spaces   in\nit ", 50)).toBe("Spaces in it");
  });
});

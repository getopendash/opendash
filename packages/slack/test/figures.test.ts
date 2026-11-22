// An answer's headline figures in Slack: a card each, side by side in a carousel a group (under its heading), its change
// with an arrow from its sign, a line more and its trend; never markup from what it says, never a number cut in two;
// or, where Slack refuses cards, Slack's classic fields.
import type { ResolvedFigure, RunOutcome } from "@opendash/core";
import { describe, expect, it } from "vitest";
import { answerCard } from "../src/card";
import { changeLine, figureCards, figureFields, figureLines, sparkline, tone } from "../src/figures";
import { fileSources, noticeText } from "../src/reply";

const ref = (display: string, kind: "number" | "text" = "number") => ({
  ref: "q1:0:x",
  display,
  kind,
  citations: [{ alias: "q1", queryRunId: "run-1", row: 0, column: "x" }],
});
const point = (display: string, value: number, row: number) => ({
  value,
  display,
  cell: { alias: "q1", queryRunId: "run-1", row, column: "x" },
});

const acquisition: ResolvedFigure = {
  label: "Acquisition",
  value: [ref("15,580")],
  change: { segments: [ref("-5%")], direction: "down" },
  vs: "vs last week",
  detail: [ref("6,727"), { text: " activated" }],
  trend: { label: "Last weeks", points: [point("6.0k", 6000, 0), point("6.2k", 6200, 1), point("6.7k", 6700, 2)] },
};
const channel = (label: string, value: string, group = "Paid channels"): ResolvedFigure => ({
  label,
  value: [ref(value)],
  change: { segments: [ref("+13%")], direction: "up" },
  vs: "vs last week",
  group,
});

describe("headline figures as Slack's cards", () => {
  it("are a card each, two a row, a group under its heading: its number on top, its label, a dot for good or bad news", () => {
    const blocks = figureCards([
      acquisition,
      channel("Google Ads", "$55"),
      channel("Meta", "$70"),
      channel("Search", "$12"),
    ]);
    expect(blocks.map((b) => b.type)).toEqual(["carousel", "section", "carousel", "carousel"]);
    expect(blocks[1]).toEqual({ type: "section", text: { type: "mrkdwn", text: "*Paid channels*" } });
    const cards = blocks.map((b) => (b.elements ?? []) as Record<string, { text: string }>[]);
    expect(cards.map((row) => row.length)).toEqual([1, 0, 2, 1]);
    expect(cards[0]?.[0]).toEqual({
      type: "card",
      title: { type: "mrkdwn", text: "*15,580*" },
      subtitle: { type: "mrkdwn", text: "Acquisition" },
      body: { type: "mrkdwn", text: "🔴 ▼ 5% vs last week\n6,727 activated\nLast weeks ▁▃█" },
    });
    expect(cards[2]?.[0]?.body?.text).toBe("🟢 ▲ 13% vs last week");
  });

  it("are good news or bad by what the measure is: down is good where lower is better", () => {
    expect(tone(acquisition)).toBe("bad");
    expect(tone({ ...acquisition, lowerIsBetter: true })).toBe("good");
    expect(tone(channel("Meta", "$70"))).toBe("good");
    expect(tone({ ...channel("Churn", "$70"), lowerIsBetter: true })).toBe("bad");
    expect(tone({ ...acquisition, change: { segments: [ref("0%")], direction: "flat" } })).toBeNull();
    expect(tone({ label: "MRR", value: [ref("$1")] })).toBeNull();
  });

  it("draw a trend as a sparkline, lowest to highest, a flat one level", () => {
    expect(sparkline([1, 2, 3, 4, 5, 6, 7, 8])).toBe("▁▂▃▄▅▆▇█");
    expect(sparkline([-5, 0, 5])).toBe("▁▅█");
    expect(sparkline([3, 3, 3])).toBe("▄▄▄");
  });

  it("say a change's direction with its arrow, and its size without a sign", () => {
    expect(changeLine(channel("Meta", "$70"))).toBe("▲ 13% vs last week");
    expect(changeLine({ ...acquisition, change: { segments: [ref("0%")], direction: "flat" }, vs: undefined })).toBe(
      "→ 0%",
    );
    expect(changeLine({ label: "MRR", value: [ref("$1")] })).toBeNull();
  });

  it("make nothing in a label or a line markup, and notify nobody", () => {
    const loud: ResolvedFigure = { ...acquisition, label: "<!channel> <https://x.example|Go> & co", detail: [] };
    const card = (figureCards([loud])[0] as { elements: { subtitle: { text: string } }[] }).elements[0];
    expect(card?.subtitle.text).not.toContain("<!channel>");
    expect(card?.subtitle.text).not.toContain("<https");
    expect(card?.subtitle.text).toContain("&amp;");
  });

  it("never cut a number: past a card's room the line more goes, then the trend; a long label is cut, not the value", () => {
    const wordy = { ...acquisition, detail: [{ text: "x".repeat(190) }] };
    const body = (figureCards([wordy])[0] as { elements: { body?: { text: string } }[] }).elements[0]?.body?.text;
    expect(body).toBe("🔴 ▼ 5% vs last week\nLast weeks ▁▃█");
    const named = { ...acquisition, label: "x".repeat(200) };
    const [card] = (figureCards([named])[0] as { elements: { title: { text: string }; subtitle: { text: string } }[] })
      .elements;
    expect(card?.title.text).toBe("*15,580*");
    expect(card?.subtitle.text).toHaveLength(150);
  });

  it("are Slack's classic fields, as plain text, where cards aren't sent: a section a group, ten fields at most", () => {
    const blocks = figureFields([acquisition, channel("Google Ads", "$55"), channel("Meta", "$70")]);
    const text = (t: string) => ({ type: "plain_text", text: t, emoji: false });
    expect(blocks).toEqual([
      {
        type: "section",
        fields: [text("Acquisition\n15,580\n🔴 ▼ 5% vs last week\n6,727 activated\nLast weeks ▁▃█")],
      },
      {
        type: "section",
        text: text("Paid channels"),
        fields: [text("Google Ads\n$55\n🟢 ▲ 13% vs last week"), text("Meta\n$70\n🟢 ▲ 13% vs last week")],
      },
    ]);
    const many = Array.from({ length: 12 }, (_, i) => channel(`C${i}`, "$1", ""));
    expect(
      figureFields(many.map((f) => ({ ...f, group: undefined }))).map((b) => (b.fields as unknown[]).length),
    ).toEqual([10, 2]);
  });

  it("go as plain fields when their words would read as formatting, never struck or bold by accident", () => {
    const struck: ResolvedFigure = { label: "Sales", value: [ref("12,345")], detail: [ref("~old~", "text")] };
    const blocks = figureCards([struck]);
    expect(blocks.map((b) => b.type)).toEqual(["section"]);
    expect(JSON.stringify(blocks)).toContain('"type":"plain_text"');
  });

  it("drop the trend, then the line more, rather than cut a number past a field's room", () => {
    const long: ResolvedFigure = { label: "Orders", value: [ref("12,345")], detail: [{ text: "x".repeat(1_990) }] };
    const [section] = figureFields([long]);
    expect(((section?.fields ?? []) as { text: string }[])[0]?.text).toBe("Orders\n12,345");
  });
});

describe("an answer with headline figures, as a card", () => {
  const answer = (over: Record<string, unknown>): RunOutcome =>
    ({
      kind: "answer",
      status: "answered",
      verified: true,
      path: "unmodelled",
      markdown: "",
      rendered: "Activated riders rose.",
      interpretation: [],
      caveats: [],
      citations: [{ queryRunId: "run-1" }],
      values: [],
      problems: [],
      segments: { markdown: [{ text: "Activated riders rose." }], caveats: [], interpretation: [] },
      ...over,
    }) as unknown as RunOutcome;

  it("opens with its heading, then its figures as cards, then its words", () => {
    const card = answerCard(answer({ title: "Growth at a glance", figures: [acquisition] }));
    expect(card?.blocks.map((b) => b.type)).toEqual(["header", "carousel", "markdown"]);
    expect(card?.blocks[0]).toEqual({
      type: "header",
      text: { type: "plain_text", text: "Growth at a glance", emoji: true },
    });
  });

  it("is a card for its figures alone; a heading alone isn't reason enough", () => {
    expect(answerCard(answer({ figures: [acquisition] }))?.blocks.map((b) => b.type)).toEqual(["carousel", "markdown"]);
    expect(answerCard(answer({ title: "Growth" }))).toBeNull();
  });
});

describe("headline figures, said whole", () => {
  it("take the sign off a change's own number, spaces and all", () => {
    const spaced: ResolvedFigure = {
      label: "Orders",
      value: [ref("40")],
      change: { segments: [{ text: " " }, ref("-10%"), { text: " " }], direction: "down" },
    };
    expect(changeLine(spaced)).toBe("▼ 10%");
  });

  it("go as fields, never a number cut, when a value can't fit a card whole", () => {
    const huge: ResolvedFigure = { label: "Delta", value: [ref("9".repeat(160))] };
    const blocks = figureCards([huge, acquisition]);
    expect(blocks.map((b) => b.type)).toEqual(["section"]);
    expect(JSON.stringify(blocks)).toContain("9".repeat(160));
  });

  it("are lines for a notification and a screen reader, the words after them, quieted, cut between words", () => {
    expect(figureLines([acquisition, channel("Meta", "$70")])).toEqual([
      "Acquisition: 15,580 (▼ 5% vs last week) · 6,727 activated",
      "Paid channels · Meta: $70 (▲ 13% vs last week)",
    ]);
    const said = { title: "Growth at a glance", figures: [acquisition] };
    expect(noticeText(said, "Activated riders rose.")).toBe(
      "Growth at a glance\nAcquisition: 15,580 (▼ 5% vs last week) · 6,727 activated\nActivated riders rose.",
    );
    // A small room: the heading, then as many of the words as fit, never none.
    expect(noticeText(said, "Activated riders rose.", 30)).toBe("Growth at a glance\nActivated…");
    expect(noticeText({ title: "Hi <!channel>", figures: [] }, "Words.")).not.toContain("<!channel>");
  });

  it("are files to download too: the queries behind a figure and its trend", () => {
    const traced = (queryRunId: string) => ({
      ...ref("1"),
      citations: [{ alias: "q1", queryRunId, row: 0, column: "x" }],
    });
    const outcome = {
      kind: "answer",
      citations: [],
      figures: [
        {
          label: "A",
          value: [traced("run-a")],
          trend: {
            points: [{ value: 1, display: "1", cell: { alias: "q2", queryRunId: "run-t", row: 0, column: "x" } }],
          },
        },
      ],
    } as unknown as RunOutcome;
    expect(fileSources(outcome)).toEqual(["run-a", "run-t"]);
  });
});

// An answer's headline figures in Slack: a card each, side by side in a carousel a group (under its heading), its change
// with an arrow from its sign, a line more and its trend; never markup from what it says, never a number cut in two;
// or, where Slack refuses cards, Slack's classic fields.
import type { ResolvedFigure, RunOutcome } from "@opendash/core";
import { describe, expect, it } from "vitest";
import { answerCard } from "../src/card";
import { changeLine, figureCards, figureFields, figureLines } from "../src/figures";
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
  it("are a card each, in a carousel a group under its heading, in the order given", () => {
    const blocks = figureCards([acquisition, channel("Google Ads", "$55"), channel("Meta", "$70")]);
    expect(blocks.map((b) => b.type)).toEqual(["carousel", "section", "carousel"]);
    expect(blocks[1]).toEqual({ type: "section", text: { type: "mrkdwn", text: "*Paid channels*" } });
    const [first] = (blocks[0] as { elements: Record<string, { text: string }>[] }).elements;
    expect(first).toEqual({
      type: "card",
      title: { type: "mrkdwn", text: "*Acquisition: 15,580*" },
      subtitle: { type: "mrkdwn", text: "▼ 5% vs last week" },
      body: { type: "mrkdwn", text: "6,727 activated\nLast weeks: 6.0k · 6.2k · 6.7k" },
    });
    expect((blocks[2] as { elements: unknown[] }).elements).toHaveLength(2);
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
    const card = (figureCards([loud])[0] as { elements: { title: { text: string } }[] }).elements[0];
    expect(card?.title.text).not.toContain("<!channel>");
    expect(card?.title.text).not.toContain("<https");
    expect(card?.title.text).toContain("&amp;");
  });

  it("never cut a number: past a card's room the trend goes, then the line more; a long label is cut, not the value", () => {
    const long = Array.from({ length: 30 }, (_, i) => point(`${i}.0k`, i, i));
    const crowded = { ...acquisition, trend: { label: "Every week", points: long } };
    const body = (figureCards([crowded])[0] as { elements: { body?: { text: string } }[] }).elements[0]?.body?.text;
    expect(body).toBe("6,727 activated");
    const named = { ...acquisition, label: "x".repeat(200) };
    const title = (figureCards([named])[0] as { elements: { title: { text: string } }[] }).elements[0]?.title.text;
    expect(title?.endsWith(": 15,580*")).toBe(true);
    expect(title?.length).toBeLessThanOrEqual(152);
  });

  it("are Slack's classic fields where cards aren't sent: a section a group, ten fields at most", () => {
    const blocks = figureFields([acquisition, channel("Google Ads", "$55"), channel("Meta", "$70")]);
    expect(blocks).toEqual([
      {
        type: "section",
        fields: [
          {
            type: "mrkdwn",
            text: "*Acquisition*\n15,580\n▼ 5% vs last week\n6,727 activated\nLast weeks: 6.0k · 6.2k · 6.7k",
          },
        ],
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: "*Paid channels*" },
        fields: [
          { type: "mrkdwn", text: "*Google Ads*\n$55\n▲ 13% vs last week" },
          { type: "mrkdwn", text: "*Meta*\n$70\n▲ 13% vs last week" },
        ],
      },
    ]);
    const many = Array.from({ length: 12 }, (_, i) => channel(`C${i}`, "$1", ""));
    expect(
      figureFields(many.map((f) => ({ ...f, group: undefined }))).map((b) => (b.fields as unknown[]).length),
    ).toEqual([10, 2]);
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

  it("are lines for a notification and a screen reader, whole lines within the room", () => {
    expect(figureLines([acquisition])).toEqual(["Acquisition: 15,580 (▼ 5% vs last week)"]);
    const said = { title: "Growth at a glance", figures: [acquisition] };
    expect(noticeText(said, "Activated riders rose.")).toBe(
      "Growth at a glance\nAcquisition: 15,580 (▼ 5% vs last week)\nActivated riders rose.",
    );
    expect(noticeText(said, "Activated riders rose.", 30)).toBe("Growth at a glance");
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

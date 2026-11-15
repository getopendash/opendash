// The agent's questions as one Slack message: each with its radio buttons, or checkboxes where more than
// one may apply, every block and action its own id, the options within Slack's length, the agent's text escaped, and
// Send naming the run; the picks read back from the press's state; the form once answered, with nothing to press.
import { describe, expect, it } from "vitest";
import { answeredText, askBlocks, picksOf, SEND_ACTION } from "../src/ask";

const questions = [
  { question: "Which measure <matters> most?", options: ["Orders", "Customers"], multiple: true },
  { question: "Which window?", options: ["Last year", `The last three months, month by month, ${"x".repeat(80)}`] },
];
type Block = { type: string; block_id?: string; text?: { text: string }; elements?: Record<string, unknown>[] };

describe("questions in Slack", () => {
  it("are one message: a heading each, its choices, then Send naming the run", () => {
    const { blocks, text } = askBlocks(questions, { runId: "run-1", channel: true }) as {
      blocks: Block[];
      text: string;
    };
    // The second question has an option longer than Slack shows: its options are said in full above them.
    expect(blocks.map((b) => b.type)).toEqual([
      "section",
      "actions",
      "section",
      "section",
      "actions",
      "actions",
      "context",
    ]);
    expect(blocks[0]?.text?.text).toBe("*1. Which measure &lt;matters&gt; most?*");
    const [checks, radios] = [blocks[1]?.elements?.[0], blocks[4]?.elements?.[0]] as Record<string, unknown>[];
    expect([checks?.type, radios?.type]).toEqual(["checkboxes", "radio_buttons"]);
    expect([blocks[1]?.block_id, checks?.action_id, blocks[4]?.block_id, radios?.action_id]).toEqual([
      "opendash:q:0",
      "opendash:pick:0",
      "opendash:q:1",
      "opendash:pick:1",
    ]);
    const long = ((radios?.options ?? []) as { text: { text: string } }[])[1]?.text.text ?? "";
    expect(long.length).toBeLessThanOrEqual(75);
    expect(long.endsWith("…")).toBe(true);
    const whole = (questions[1]?.options ?? [])[1] ?? "";
    expect(blocks[3]?.text?.text).toContain(`2. ${whole}`);
    expect(blocks[5]?.elements?.[0]).toMatchObject({ action_id: SEND_ACTION, value: JSON.stringify({ r: "run-1" }) });
    expect(JSON.stringify(blocks[6])).toContain("mentioning @opendash");
    expect(text).toContain("Which window?");
    // One question: the message above it is the question; its choices follow straight on.
    const [first] = questions;
    expect((askBlocks([first as never], { runId: "r", channel: false }).blocks as Block[]).map((b) => b.type)).toEqual([
      "actions",
      "actions",
      "context",
    ]);
  });

  it("read the picks from the press's state, and show what was answered", () => {
    const state = {
      values: {
        "opendash:q:0": { "opendash:pick:0": { selected_options: [{ value: "0" }, { value: "1" }, { value: "9" }] } },
        "opendash:q:1": { "opendash:pick:1": { selected_option: { value: "1" } } },
      },
    };
    expect(picksOf(state, questions)).toEqual([[0, 1], [1]]);
    expect(picksOf({ values: {} }, questions)).toEqual([[], []]);
    expect(answeredText(questions, [[0], [0]])).toBe(
      "You answered:\n- Which measure <matters> most? **Orders**\n- Which window? **Last year**",
    );
  });
});

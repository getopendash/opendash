/**
 * The agent's questions in Slack. One question with one pick stays a row of buttons, sent on the press.
 * Anything else is one message: each question with its radio buttons, or checkboxes where more than one may apply,
 * and Send. Slack sends every group's current picks with the Send press (`state.values`), so nothing half-answered is
 * kept on the server, and the person can still answer in their own words instead. Pure, for tests.
 */
import type { ClarifyQuestion } from "@opendash/core";

/** A question's block and its options' action, by the question's place. */
export const pickBlock = (i: number) => `opendash:q:${i}`;
/** A tick in a question's form: acknowledged, never recorded or asked (Send carries every pick). */
export const PICK_PREFIX = "opendash:pick:";
export const pickAction = (i: number) => `${PICK_PREFIX}${i}`;
/** The Send button's action: its value names the run that asked. */
export const SEND_ACTION = "opendash:send";

/** Slack's longest option text (radio buttons, checkboxes) and button label. */
const OPTION_TEXT = 75;
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
/** An option's or a button's words as Slack shows them: at most 75 characters, cut with an ellipsis. */
export const buttonText = (s: string) => cut(s, OPTION_TEXT);

/**
 * The choices said in full, numbered, where Slack cuts one: a press asks or answers with the whole text, so the whole
 * text is shown with them. Null when every one fits.
 */
export function spelledOut(texts: string[], heading?: string): Record<string, unknown> | null {
  if (texts.every((t) => t.length <= OPTION_TEXT)) return null;
  const list = texts.map((t, i) => `${i + 1}. ${t}`).join("\n");
  return {
    type: "section",
    text: { type: "plain_text", text: (heading ? `${heading}\n${list}` : list).slice(0, 3_000), emoji: false },
  };
}
/** Text from the agent, in Slack's own markup: its three special characters escaped. */
const escaped = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The questions as one message's blocks: a heading each where there are several, its options, then Send and how to
 * answer in their own words instead (in a channel, by mentioning OpenDash). `text` is what a notification shows.
 */
export function askBlocks(
  questions: ClarifyQuestion[],
  at: { runId: string; channel: boolean },
): { blocks: Record<string, unknown>[]; text: string } {
  const several = questions.length > 1;
  const blocks = questions.flatMap((q, i): Record<string, unknown>[] => [
    // One question is the message above it, already: its options follow straight on.
    ...(several ? [{ type: "section", text: { type: "mrkdwn", text: `*${i + 1}. ${escaped(q.question)}*` } }] : []),
    ...[spelledOut(q.options)].filter((b): b is Record<string, unknown> => b !== null),
    {
      type: "actions",
      block_id: pickBlock(i),
      elements: [
        {
          type: q.multiple ? "checkboxes" : "radio_buttons",
          action_id: pickAction(i),
          options: q.options.map((o, k) => ({
            text: { type: "plain_text", text: buttonText(o) },
            value: String(k),
          })),
        },
      ],
    },
  ]);
  blocks.push(
    {
      type: "actions",
      block_id: "opendash:send",
      elements: [
        {
          type: "button",
          style: "primary",
          action_id: SEND_ACTION,
          text: { type: "plain_text", text: "Send" },
          value: JSON.stringify({ r: at.runId }),
        },
      ],
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: at.channel
            ? "Or reply in this thread in your own words, mentioning @opendash."
            : "Or reply in your own words.",
        },
      ],
    },
  );
  return { blocks, text: questions.map((q) => q.question).join(" ") };
}

type Picked = { value?: string };
type StateValues = Record<string, Record<string, { selected_option?: Picked | null; selected_options?: Picked[] }>>;

/** The picks a Send press carries: a question's option places, empty where none is picked. */
export function picksOf(state: unknown, questions: ClarifyQuestion[]): number[][] {
  const values = ((state ?? {}) as { values?: StateValues }).values ?? {};
  return questions.map((q, i) => {
    const v = values[pickBlock(i)]?.[pickAction(i)];
    const chosen = v?.selected_options ?? (v?.selected_option ? [v.selected_option] : []);
    return chosen.map((o) => Number(o.value)).filter((n) => Number.isInteger(n) && n >= 0 && n < q.options.length);
  });
}

/** The form once answered, as Markdown: what was picked, a line a question, and no controls left. */
export function answeredText(questions: ClarifyQuestion[], picks: number[][]): string {
  const lines = questions.map((q, i) => {
    const chosen = (picks[i] ?? []).map((p) => q.options[p]).filter((o): o is string => o !== undefined);
    return questions.length > 1 ? `- ${q.question} **${chosen.join(", ")}**` : `**${chosen.join(", ")}**`;
  });
  return `You answered:\n${lines.join("\n")}`;
}

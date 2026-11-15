/**
 * A routine's post in a Slack channel: the same message its email says, as Block Kit. A scheduled question's answer,
 * what's open in Insights, or what was found; each with its page in OpenDash, and the routine that sent it beneath. A finding has a menu: Investigate, or Dismiss with why, both checked
 * again when pressed (bot.ts). Within Slack's limits: a header's 150 characters, a section's 3,000, ten fields.
 */
import { DISMISS_REASONS, type DismissReason, type RoutineMessage } from "@opendash/core";

/** A finding's menu: Investigate, or Dismiss with why. */
export const ROUTINE_FINDING = "opendash:routine:finding";

const REASONS: Record<DismissReason, string> = {
  not_a_problem: "Dismiss: not a problem",
  known_issue: "Dismiss: a known issue",
  wrong_data: "Dismiss: wrong data",
  not_my_area: "Dismiss: not my area",
};

const WHEN = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});

/**
 * Slack's mrkdwn treats these three as markup; and a plain "@channel" a word joiner keeps from ever becoming one (the
 * blocks are verbatim too, so Slack parses no mention or channel name in what they say).
 */
const esc = (t: string) =>
  t
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    // Not inside an address (ops@channel.example): only where the @ starts a word.
    .replace(/(^|[^\w.+-])@(here|channel|everyone)\b/gi, "$1@\u2060$2");
const cut = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
const plain = (t: string, n = 2_000) => ({ type: "plain_text", text: cut(t, n), emoji: false });
const mrkdwn = (t: string, n = 3_000) => ({ type: "mrkdwn", text: cut(t, n), verbatim: true });
const header = (t: string) => ({ type: "header", text: plain(t.replace(/\s+/g, " "), 150) });
const section = (t: string) => ({ type: "section", text: mrkdwn(t) });
const context = (...lines: string[]) => ({ type: "context", elements: lines.map((l) => mrkdwn(l, 2_000)) });
const button = (label: string, url: string, primary = false) => ({
  type: "button",
  text: plain(label, 75),
  url,
  ...(primary ? { style: "primary" } : {}),
});
const actions = (...elements: unknown[]) => ({ type: "actions", elements });
/**
 * What a routine's post says: its text (what a notification shows, and what's posted alone where Slack refuses the
 * blocks) and its blocks. Slack reads the text as markup too, so it's escaped like the blocks: a question that says
 * `<!channel>` mentions nobody.
 */
export function routineBlocks(m: RoutineMessage): { text: string; blocks: Record<string, unknown>[] } {
  const said = unescaped(m);
  return { text: esc(cut(said.text, 3_000)), blocks: said.blocks };
}

function unescaped(m: RoutineMessage): { text: string; blocks: Record<string, unknown>[] } {
  const footer = context(`Sent by a routine: <${m.routineUrl}|${esc(cut(m.because, 300))}>`);
  if (m.kind === "answer") {
    const a = m.answer;
    const url = `${a.baseUrl.replace(/\/$/, "")}/ask/${encodeURIComponent(a.threadId)}`;
    return {
      text: `${a.question}: ${cut(a.answer, 200)}`,
      blocks: [
        header(a.question),
        context(
          `Answered ${WHEN.format(new Date(a.answeredAt))} UTC from ${esc(a.sourceName)}${a.verified ? "" : " · some of it couldn't be checked, as marked in OpenDash"}`,
        ),
        section(esc(a.answer)),
        actions(button("Open the answer", url, true)),
        footer,
      ],
    };
  }
  if (m.kind === "digest") {
    const d = m.digest;
    const base = d.baseUrl.replace(/\/$/, "");
    const lines = (items: { title: string; detail?: string }[]) =>
      items.map((i) => `• *${esc(i.title)}*${i.detail ? ` · ${esc(i.detail)}` : ""}`).join("\n");
    return {
      text: `What's open at ${d.organization}: ${d.counts.insights} ${d.counts.insights === 1 ? "insight" : "insights"}`,
      blocks: [
        header(`What's open at ${d.organization}`),
        ...(d.insights.length ? [section(lines(d.insights))] : []),
        ...(d.tasks.length ? [section(`*Tasks*\n${lines(d.tasks)}`)] : []),
        ...(d.counts.insights > d.insights.length
          ? [context(`${d.counts.insights - d.insights.length} more in Insights.`)]
          : []),
        actions(button("Open Insights", `${base}/insights`, true)),
        footer,
      ],
    };
  }
  if (m.kind === "findings") {
    const f = m.findings;
    const base = f.baseUrl.replace(/\/$/, "");
    const first = f.findings[0];
    const shown = f.findings.slice(0, 10);
    return {
      text:
        f.roundup || !first
          ? `${f.findings.length} ${f.findings.length === 1 ? "finding" : "findings"} at ${f.organization} today`
          : `${first.title}: ${first.detail}`,
      blocks: [
        header(f.roundup ? "Today's findings" : "OpenDash found something"),
        ...shown.map((i) => ({
          type: "section",
          text: mrkdwn(
            `*<${base}/insights#${encodeURIComponent(i.id)}|${esc(i.title)}>*\n${esc(i.detail)}${i.verdict ? `\n_${esc(i.verdict)}_` : ""}`,
          ),
          accessory: {
            type: "overflow",
            action_id: ROUTINE_FINDING,
            options: [
              { text: plain("Investigate", 75), value: JSON.stringify({ a: "investigate", i: i.id }) },
              ...DISMISS_REASONS.map((r) => ({
                text: plain(REASONS[r], 75),
                value: JSON.stringify({ a: "dismiss", i: i.id, r }),
              })),
            ],
          },
        })),
        ...(f.findings.length > shown.length ? [context(`${f.findings.length - shown.length} more in Insights.`)] : []),
        actions(button("Open Insights", `${base}/insights`, true)),
        footer,
      ],
    };
  }
  // A routine's pause is told to its owner by email; a channel never gets it.
  return { text: m.paused.reason, blocks: [section(esc(m.paused.reason)), footer] };
}

/** A finding's menu choice, read back: what to do, to which insight, and why for a dismissal. */
export function findingChoice(
  value: string | undefined,
):
  | { action: "investigate"; insightId: string }
  | { action: "dismiss"; insightId: string; reason: DismissReason }
  | null {
  try {
    const v = JSON.parse(value ?? "") as { a?: unknown; i?: unknown; r?: unknown };
    if (typeof v.i !== "string") return null;
    if (v.a === "investigate") return { action: "investigate", insightId: v.i };
    if (v.a === "dismiss" && DISMISS_REASONS.includes(v.r as DismissReason)) {
      return { action: "dismiss", insightId: v.i, reason: v.r as DismissReason };
    }
    return null;
  } catch {
    return null;
  }
}

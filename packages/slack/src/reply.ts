/**
 * A run as a Slack reply: while it works, its current step on Slack's status line
 * (the shimmer under the question); then the answer as OpenDash renders it (every number already resolved from its
 * cell) with a one-line footer; and each cited query's rows as CSV. Pure, for tests; the worker posts.
 */

import {
  type ClarifyQuestion,
  clarifyQuestions,
  type QueryCard,
  type ResolvedChart,
  type RunOutcome,
} from "@opendash/core";
import { queryCsv } from "@opendash/core/csv";
import { visibleLinks } from "@opendash/markdown";
import { spelledOut } from "./ask";
import { LEARNING_SUGGEST } from "./learning";

/** A run event, as the reply reads it. */
export type Event = { seq: number; type: string; data: Record<string, unknown> };

/** Slack refuses a status line longer than this (as found in production). */
export const STATUS_LIMIT = 50;

/** One line of input for a status: no line breaks, at most `n` characters. */
const clip = (value: unknown, n: number) => {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return [...text].length <= n ? text : `${[...text].slice(0, Math.max(n - 1, 1)).join("")}…`;
};

/** A line with a named thing in it, the name cut so the whole fits Slack's limit. */
const named = (before: string, name: unknown, after = "…", quote = true) => {
  const room = STATUS_LIMIT - [...before].length - [...after].length - (quote ? 2 : 0);
  const shown = clip(name, room);
  if (!shown) return null;
  return quote ? `${before}“${shown}”${after}` : `${before}${shown}${after}`;
};

/** What a step is doing, as the status line says it: what someone reading Slack recognizes, never SQL. */
export function stepStatus(tool: string, input: Record<string, unknown> = {}): string {
  switch (tool) {
    case "read": {
      // A file of the knowledge folder: a table's, a skill's, or one of the team's definitions.
      const path = typeof input.path === "string" ? input.path : "";
      const table = /\/tables\/(.+)\.md$/.exec(path)?.[1];
      if (table) return named("Reading the table ", table, "…", false) ?? "Reading a table…";
      // An earlier result, read back (nothing reruns).
      const result = /^\/results\/(q\d+)/.exec(path)?.[1];
      if (result) return `Reading ${result}'s rows again…`;
      return path.startsWith("/skills/") ? "Reading a skill…" : "Reading the definitions…";
    }
    case "ls":
      return "Looking through what OpenDash knows…";
    case "grep":
      return named("Searching for ", input.pattern) ?? "Searching…";
    case "value_lookup":
      return named("Looking up ", input.term) ?? "Looking up a value…";
    case "metric_query": {
      const metrics = Array.isArray(input.metrics) ? input.metrics.filter((m) => typeof m === "string") : [];
      return (
        named(metrics.length === 1 ? "Asking the metric " : "Asking the metrics ", metrics.join(", "), "…", false) ??
        "Asking the metrics…"
      );
    }
    case "context_search":
      return "Searching the definitions…";
    case "sql_check":
      return "Checking the SQL…";
    case "sql_query":
      return named("Running ", input.title) ?? "Running a query…";
    case "remember":
      return input.forget === true ? "Letting that go…" : "Noting that for next time…";
    case "answer":
      return "Checking every number…";
    case "clarify":
      return "Writing you a question…";
    case "mcp_find":
      return "Looking for a connected service…";
    case "mcp_call":
      // The service's own tool, by name: "Using search_issues…".
      return named("Using ", input.tool) ?? "Using a connected service…";
    default:
      return "Working on it…";
  }
}

/** What the status says once a step is done, while the next is being thought of; null keeps the step's own line. */
function afterStep(data: Record<string, unknown>): string | null {
  if (data.status !== "succeeded" || data.failed) return "Trying another way…";
  if (data.tool === "answer") return data.accepted ? null : "Fixing the answer…";
  if (data.tool === "sql_query" || data.tool === "metric_query") return "Reading the results…";
  return null;
}

/** The status line after these events (the latest step's), or null when they change nothing. */
export function statusAfter(events: Event[]): string | null {
  let line: string | null = null;
  for (const e of events) {
    if (e.type === "tool_started")
      line = stepStatus(String(e.data.tool), (e.data.input ?? {}) as Record<string, unknown>);
    else if (e.type === "tool_result") line = afterStep(e.data) ?? line;
    // A follow-up sent meanwhile, read before the next step.
    else if (e.type === "input_joined") line = "Reading your follow-up…";
  }
  return line;
}

const JOINER = "\u2060";

/**
 * Text from an answer, so posting it notifies nobody (an answer can carry a customer's data, and data can carry
 * anything). Everywhere in it, code included: what counts as code differs between Markdown
 * parsers (an escaped backtick, a longer fence), so no part is trusted to be inert.
 * - Slack's mention markup (<!here>, <!channel>, <@U…>, <!subteam^…>, <#C…>) becomes plain text;
 * - the same written with an HTML entity (&lt;!here&gt;) gets a joiner after the entity, so it can't decode into one;
 * - every @ gets an invisible joiner after it, so the Slack adapter can't turn a name into a mention.
 */
export function quiet(text: string): string {
  return text
    .replace(/<([!@#])([^<>\n]*)>/g, (_m, sigil: string, body: string) => {
      const label = (body.includes("|") ? body.slice(body.indexOf("|") + 1) : body)
        .replace(/^subteam\^/, "")
        .replace(/^[@#!]+/, "");
      return `${sigil === "#" ? "#" : "@"}${label}`;
    })
    .replace(/(&(?:lt|#0*60|#x0*3c);)(?=[!@#])/gi, `$1${JOINER}`)
    .replaceAll("@", `@${JOINER}`);
}

/** Slack's limit for a message's markdown is 12,000 characters; a part stays under it with room for its footer. */
export const MESSAGE_LIMIT = 10_000;
/** An answer longer than this many messages goes on in OpenDash. */
export const MAX_MESSAGES = 5;

/**
 * Text cut into Slack messages: at a paragraph break, else a line break, else a space, but never in the first three
 * quarters of a message (so one long table can't become many small ones), and never inside a character.
 */
export function splitMessage(text: string, limit = MESSAGE_LIMIT): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    const floor = Math.floor(limit * 0.75);
    let cut = rest.lastIndexOf("\n\n", limit);
    if (cut < floor) cut = rest.lastIndexOf("\n", limit);
    if (cut < floor) cut = rest.lastIndexOf(" ", limit);
    if (cut < floor) cut = limit;
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

export interface ReplyText {
  /** The reply, as one or more Slack messages (Markdown): the answer's own words. */
  messages: string[];
  /** A quiet line under the last of them, as plain text: whether every number is checked, what's only in OpenDash. */
  footer: string | null;
  /** The way into OpenDash, as a button: its words, and where it goes. */
  open: { label: string; url: string };
  /** Up to three follow-ups the answer offers (its `next`), each a button that asks it. */
  next: string[];
  /** An answer the asker can rate (👍/👎). */
  rate: boolean;
  /** The questions it asked back: buttons for one with one pick, else a form with Send. */
  questions?: ClarifyQuestion[];
  /** The query runs its numbers cite, for their CSV files. */
  cited: string[];
  /** Whether it's an answer to the question (an answer, a question back, or why it can't), not a failure or a stop. */
  answered: boolean;
}

const link = (label: string, url: string) => `[${label}](${url})`;

/**
 * The answer's own links with their address in sight (`visibleLinks`, read by the markdown parser itself): an answer is
 * the model's writing, steered by the data it read, and a link hidden behind its text could carry what it read to
 * someone else's site. OpenDash's own links (its buttons) aren't the answer's.
 */
export { visibleLinks };

/** The reply in messages; one too long for Slack ends with a link to the rest. */
function messages(body: string, url: string): string[] {
  const parts = splitMessage(quiet(visibleLinks(body)));
  const kept = parts.slice(0, MAX_MESSAGES);
  if (parts.length > MAX_MESSAGES)
    kept[kept.length - 1] += `\n\n_(The rest is in OpenDash: ${link("read it all", url)}.)_`;
  return kept;
}

type Answer = Extract<RunOutcome, { kind: "answer" }>;

/** The queries an answer cites, each once. */
const citedQueries = (outcome: Answer) => [
  ...new Set(
    ((outcome.citations ?? []) as { queryRunId?: unknown }[]).flatMap((c) =>
      typeof c?.queryRunId === "string" ? [c.queryRunId] : [],
    ),
  ),
];

/** Whether an answer carries numbers: values it quotes, or queries it cites. A greeting or an explanation carries none. */
export function hasNumbers(outcome: Answer): boolean {
  return (outcome.values?.length ?? 0) > 0 || citedQueries(outcome).length > 0;
}

/**
 * The answer a reply's PDF draws: only an answer that answered with numbers (not a question back, a refusal, a
 * failure, or a reply with no numbers in it, such as to a greeting).
 */
export function pdfAnswer(outcome: RunOutcome | null | undefined): Answer | null {
  return outcome?.kind === "answer" && outcome.status === "answered" && hasNumbers(outcome) ? outcome : null;
}

/** A reply that's only words, with the way into OpenDash. */
const plain = (body: string, url: string, label = "Open in OpenDash", answered = true): ReplyText => ({
  messages: messages(body, url),
  footer: null,
  open: { label, url },
  next: [],
  rate: false,
  cited: [],
  answered,
});

/**
 * The reply: the answer, how it read the question, its caveats; under it, whether every number is verified, the
 * way into OpenDash (to where each number comes from), the follow-ups it offers, and 👍/👎. `url` opens the
 * conversation in OpenDash.
 */
export function replyText(outcome: RunOutcome | null, status: string, url: string): ReplyText {
  if (!outcome) {
    return plain(
      status === "cancelled" ? "Stopped." : "Something went wrong answering this. Ask again.",
      url,
      undefined,
      false,
    );
  }
  if (outcome.kind === "clarify") {
    // One question is the message, its options under it; several have a line before them, each its own heading.
    const questions = clarifyQuestions(outcome);
    if (!questions.length) return plain("I have a question for you.", url, "Answer it in OpenDash");
    const lead = questions.length === 1 ? (questions[0]?.question ?? "") : "A few questions before I answer:";
    return { ...plain(lead, url), questions };
  }
  // An insight's investigation, a Modeler's draft, a routine's proposal: never a Slack question's, said plainly should
  // one be read here.
  if (outcome.kind === "investigation") return plain(outcome.moved.rendered, url);
  if (outcome.kind === "modeler") {
    return plain(
      outcome.status === "proposed" ? "Drafted definitions for review." : (outcome.reason ?? "No draft."),
      url,
    );
  }
  if (outcome.kind === "curator")
    return plain(
      outcome.status === "proposed" ? "Proposed a learning for review." : (outcome.reason ?? "Nothing to learn."),
      url,
    );
  if (outcome.kind === "no_answer") return plain(outcome.reason, url);
  // Describe it's proposal (a routine's draft): it lives in the composer, never in Slack.
  if (outcome.kind === "composer") return plain(outcome.understood, url);
  // A connected service the person has to connect, or a call they have to allow: both are presses in
  // OpenDash. A Slack question uses only shared services, so it shouldn't end this way; said plainly if it does.
  if (outcome.kind === "mcp_connect") {
    return plain(
      `I need ${outcome.server} connected first. Connect it in OpenDash, then ask again.`,
      url,
      "Open OpenDash",
    );
  }
  if (outcome.kind === "mcp_consent") {
    return plain(
      `${outcome.tool} on ${outcome.server} asks before each use. Allow it in OpenDash.`,
      url,
      "Open OpenDash",
    );
  }
  // A dashboard is built in OpenDash, beside the conversation; a Slack question isn't given the tools, so said plainly.
  if (outcome.kind === "dashboard_plan") {
    return plain(`Dashboards are built in OpenDash: ask there for ${outcome.title}.`, url, "Open OpenDash");
  }
  // A person's run in OpenDash pauses; one from Slack keeps its budget, so this is only ever a conversation carried here.
  if (outcome.kind === "paused") {
    return plain("It paused partway through. Everything it did is kept: continue in OpenDash.", url, "Open OpenDash");
  }
  const next = (outcome.next ?? []).filter((q) => typeof q === "string" && q.trim()).slice(0, 3);
  // No numbers in it (a greeting, an explanation) and it passed its checks: just what it says, with the way into
  // OpenDash. One that didn't pass keeps its "Unverified" line below, whatever it cites.
  if (!hasNumbers(outcome) && outcome.verified && !outcome.problems.length) {
    const said = [outcome.rendered.trim(), ...outcome.caveats.map((c) => `> ${c}`)].join("\n\n");
    return { ...plain(said, url), next, rate: true };
  }
  const lines = [outcome.rendered.trim()];
  if (outcome.interpretation.length) lines.push(`_${outcome.interpretation.join(" · ")}_`);
  for (const c of outcome.caveats) lines.push(`> ${c}`);
  const facts = [
    outcome.verified
      ? outcome.path === "metric"
        ? "Verified from definitions an admin approved"
        : "Every number checked against its query"
      : `Unverified: ${(outcome.problems.join(" ") || "the answer didn't pass every check.").replace(/\.$/, "")}`,
  ];
  return {
    messages: messages(lines.join("\n\n"), url),
    footer: facts.join(" · "),
    open: { label: outcome.verified ? "See where each number comes from" : "Open in OpenDash", url },
    next,
    rate: true,
    cited: citedQueries(outcome),
    answered: true,
  };
}

/** The buttons' actions under an answer: the way into OpenDash, a follow-up, 👍/👎. */
export const OPEN_ACTION = "opendash:open";
export const nextAction = (i: number) => `opendash:next:${i}`;
export const NEXT_ACTIONS = [0, 1, 2].map(nextAction);
/** Slack's own feedback buttons, and the plain ones where Slack refuses them. */
export const FEEDBACK_ACTION = "opendash:feedback";
export const RATE_ACTIONS = ["opendash:rate:up", "opendash:rate:down"] as const;

/** A button's words: Slack takes 75 characters. */
const label = (text: string) => (text.length <= 75 ? text : `${text.slice(0, 74).trimEnd()}…`);
const words = (text: string) => ({ type: "plain_text", text: label(text), emoji: true });

/**
 * What goes under the reply's last message, as Slack blocks: its quiet line (plain text, so nothing in it is markup),
 * the way into OpenDash and the follow-ups, and 👍/👎 (`feedback`: Slack's own buttons, or plain ones where Slack
 * refuses them). A follow-up and a rating carry only the run and their place; what they say is read from the run.
 */
/** Undo of what the analyst remembered for the asker in this answer. */
export const MEMORY_UNDO = "opendash:memory:undo";

/**
 * What goes under the answer: what was checked, the buttons (the way into OpenDash, follow-ups, 👍/👎), and what it
 * remembered for its asker with Undo ("for you" in a DM, "for its asker" in a channel, where others read it too).
 */
export function replyBlocks(
  said: ReplyText,
  runId: string,
  feedback: "native" | "plain" = "native",
  remembered: { id: string; fact: string; why?: string }[] = [],
  inDm = true,
): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [];
  const shareable = remembered.slice(0, 2).filter((m) => m.why === "correction");
  for (const m of remembered.slice(0, 2)) {
    blocks.push({
      type: "section",
      text: {
        type: "plain_text",
        text: `Remembered for ${inDm ? "you" : "its asker"}: “${m.fact}”`.slice(0, 2_000),
        emoji: false,
      },
      accessory: {
        type: "button",
        action_id: MEMORY_UNDO,
        text: words("Undo"),
        value: JSON.stringify({ m: m.id }),
      },
    });
  }
  // A correction can be shared with the team's learning about it: its owner's choice, checked on press.
  if (shareable.length) {
    blocks.push({
      type: "actions",
      elements: shareable.map((m, i) => ({
        type: "button",
        action_id: i === 0 ? LEARNING_SUGGEST : `${LEARNING_SUGGEST}:${i}`,
        text: words("Suggest for the team"),
        value: JSON.stringify({ m: m.id }),
      })),
    });
  }
  if (said.footer) {
    blocks.push({
      type: "context",
      elements: [{ type: "plain_text", text: said.footer.slice(0, 2_000), emoji: false }],
    });
  }
  // A follow-up longer than its button asks all of it: said in full above the buttons.
  const full = spelledOut(said.next, "Ask next:");
  if (full) blocks.push(full);
  blocks.push({
    type: "actions",
    elements: [
      { type: "button", action_id: OPEN_ACTION, text: words(said.open.label), url: said.open.url },
      ...said.next.map((q, i) => ({
        type: "button",
        action_id: nextAction(i),
        text: words(q),
        value: JSON.stringify({ r: runId, i }),
      })),
    ],
  });
  if (said.rate && feedback === "native") {
    blocks.push({
      type: "context_actions",
      elements: [
        {
          type: "feedback_buttons",
          action_id: FEEDBACK_ACTION,
          positive_button: {
            text: { type: "plain_text", text: "Good answer" },
            value: `up:${runId}`,
            accessibility_label: "This answer was right",
          },
          negative_button: {
            text: { type: "plain_text", text: "Not right" },
            value: `down:${runId}`,
            accessibility_label: "This answer was wrong or unhelpful",
          },
        },
      ],
    });
  }
  if (said.rate && feedback === "plain") {
    blocks.push({
      type: "actions",
      elements: [
        { type: "button", action_id: RATE_ACTIONS[0], text: words("👍"), value: `up:${runId}` },
        { type: "button", action_id: RATE_ACTIONS[1], text: words("👎"), value: `down:${runId}` },
      ],
    });
  }
  return blocks;
}

export { csvCell, fileStem } from "@opendash/core/csv";

/** Slack keeps an image's alt text to about a thousand characters. */
const ALT_LIMIT = 1_000;

/**
 * A chart image's alt text, for a screen reader: its title, then each series' values by category, as the chart
 * shows them; cut to Slack's limit.
 */
export function chartAltText(chart: Pick<ResolvedChart, "title" | "categories" | "series">): string {
  const series = chart.series.map((s) => {
    const values = chart.categories.map((c, i) => `${c} ${s.points[i]?.display ?? "—"}`).join(", ");
    return chart.series.length > 1 ? `${s.name}: ${values}` : values;
  });
  const text = `${chart.title}. ${series.join("; ")}.`;
  return text.length <= ALT_LIMIT ? text : `${text.slice(0, ALT_LIMIT - 1).trimEnd()}…`;
}

/**
 * A cited query's rows as CSV: what its query card shows the asker (the stored result, at most 100 rows), the same file
 * the web chat downloads (`queryCsv`). The gateway never returns personal-data columns, so none is here.
 */
export function cardCsv(card: Pick<QueryCard, "title" | "alias" | "columns" | "preview" | "rows" | "truncated">): {
  filename: string;
  data: Buffer;
} {
  const { filename, text } = queryCsv(card);
  return { filename, data: Buffer.from(text, "utf8") };
}

/**
 * The conversation kept within what a model call may send. On a large
 * source most of a long conversation's cost was its earlier turns resent: one thread on the warehouse went past Haiku
 * 5.5's 100,000-token price line (5× past it) from its tenth question on, and those calls were 80% of what its
 * questions cost. So each call's input is counted, the system prompt and tools included, before every step:
 *   - while it's under the window's limit, the conversation goes as it is;
 *   - past it, the oldest turns give way, each to one note: the queries it ran (alias, title, columns) and what it
 *     answered, as the gate rendered it (every number in it came out of the gate), or what it asked. The note is
 *     fenced as data, since it quotes the source's values. Every person's message stays word for word (a folded
 *     question loses only the block it was sent with: its date, the verified queries like it), and a call never loses
 *     its result;
 *   - if the run's own turn is still too big, its earlier results shrink to what names them, the latest kept whole.
 * It folds down to the window's target, not just under its limit, so the rest of the run fits without folding again:
 * each fold moves the prompt cache, once.
 *
 * Deterministic, with no model call: a summary written by a model can't be checked without spending on a live model,
 * and its quality can't be judged offline. Pure: what's folded is decided by replaying the conversation's growth,
 * message by message, so the same messages fold the same way at a pass's start, mid-run and on a later attempt, and
 * the cache built on a fold holds, for as long as what every call sends besides is the same (the system prompt, the
 * tools, the question's own block): within an attempt, and between attempts unless the source changed. Earlier results
 * stay citable by alias: the gate reads them from the ledger.
 *
 * Tokens are counted as characters ÷ 2.5. Over 221 recorded steps a token was 3.25 characters (2.57 at the 10th
 * percentile), so this counts high: a fold comes a little early rather than a call crossing a price line.
 */
import { BUDGETS, clarifyQuestions, contextWindow, isBlock, isFollowUp, isNote, priceOf } from "@opendash/core";
import type { ModelMessage } from "ai";
import { inert } from "../instructions/context";

export const CHARS_PER_TOKEN = 2.5;

/** A result is shrunk only when that saves at least this many tokens: a small one (a skill's steps) stays whole. */
const MIN_SAVING = 500;

/** Something's size in tokens, as it's sent (JSON). */
/** What an image costs a model, about: a picture is read as tokens of its own, never as its bytes. */
const IMAGE_TOKENS = 1600;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** A 2 MB image, as base64. */
const MAX_IMAGE_BASE64 = Math.ceil((2 * 1024 * 1024 * 4) / 3) + 4;

export const tokensOf = (x: unknown): number => {
  let images = 0;
  const text = JSON.stringify(x ?? "", (_k, v: unknown) => {
    // A person's image: counted as a picture, its base64 left out of the count.
    // Only a real picture: an image part of a known type within the reader's bound (anything else counts as text).
    const part = v as { type?: unknown; image?: unknown; mediaType?: unknown } | null;
    if (
      part &&
      typeof part === "object" &&
      part.type === "image" &&
      typeof part.image === "string" &&
      part.image.length <= MAX_IMAGE_BASE64 &&
      typeof part.mediaType === "string" &&
      IMAGE_TYPES.has(part.mediaType)
    ) {
      images++;
      return "";
    }
    return v;
  });
  return Math.ceil(text.length / CHARS_PER_TOKEN) + images * IMAGE_TOKENS;
};

export interface InputWindow {
  /** The most a call may send, in tokens. */
  limit: number;
  /** What a fold brings it down to: the limit less room for the run's next steps. */
  target: number;
  /** How much of the latest results in the run's own turn always stays whole, in tokens. */
  keepRecent: number;
}

/** A model's window: its context less room to answer, and under its price line if it has one. */
export function inputWindow(model: string): InputWindow {
  const w = BUDGETS.agent.window;
  const priceLine = priceOf(model)?.above?.inputTokens;
  const limit = Math.min(
    contextWindow(model) - w.reserveTokens,
    priceLine ? priceLine - w.priceMarginTokens : Number.POSITIVE_INFINITY,
  );
  return { limit, target: limit - w.headroomTokens, keepRecent: w.keepRecentTokens };
}

/**
 * The window for a prompt the model said was too long (`sent` tokens, as counted here): the model's window is smaller
 * than this one says, so it folds at once, to half what was sent, with the same headroom after that, so the rest of the
 * run doesn't fold at every step.
 */
export function harder(w: InputWindow, sent: number): InputWindow {
  const target = Math.floor(Math.min(w.target, sent) / 2);
  return {
    limit: Math.min(target + (w.limit - w.target), sent - 1),
    target,
    keepRecent: Math.floor(w.keepRecent / 2),
  };
}

type Part = {
  type: string;
  toolCallId?: string;
  text?: string;
  toolName?: string;
  input?: unknown;
  output?: { type?: string; value?: unknown };
};

/** A call's input as stored, or nothing when it isn't valid JSON (a malformed call is kept as the model sent it). */
function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const partsOf = (m: ModelMessage): Part[] => (typeof m.content === "string" ? [] : (m.content as Part[]));
const cap = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** A result's columns by name, however the tool listed them. */
const columnsOf = (v: Record<string, unknown>) =>
  Array.isArray(v.columns)
    ? v.columns.flatMap((c) =>
        typeof c === "string"
          ? [c]
          : c && typeof (c as { name?: unknown }).name === "string"
            ? [(c as { name: string }).name]
            : [],
      )
    : [];

/** What a turn did, as one note: its queries by alias, then what it answered or asked, fenced as data. */
export function foldedNote(rest: ModelMessage[]): ModelMessage {
  const parts = rest.flatMap(partsOf);
  const json = (p: Part) =>
    p.type === "tool-result" && p.output?.type === "json" && p.output.value && typeof p.output.value === "object"
      ? (p.output.value as Record<string, unknown>)
      : null;
  const queries = parts.flatMap((p) => {
    const v = json(p);
    if (!v || typeof v.alias !== "string") return [];
    const cols = columnsOf(v);
    return [
      `${v.alias}${typeof v.title === "string" ? ` · ${v.title}` : ""}${cols.length ? ` (${cols.join(", ")})` : ""}`,
    ];
  });
  // What it answered, as the gate rendered it; or what it asked back, from a clarify that ran (one whose input didn't
  // fit is kept as the model sent it, whatever its shape).
  const accepted = parts
    .filter((p) => p.type === "tool-result" && p.toolName === "answer")
    .map(json)
    .filter((v): v is Record<string, unknown> => Boolean(v?.accepted) && typeof v?.rendered === "string")
    .at(-1);
  const ran = new Set(parts.flatMap((p) => (p.toolName === "clarify" && json(p) ? [p.toolCallId] : [])));
  const asked = parts.filter((p) => p.type === "tool-call" && p.toolName === "clarify" && ran.has(p.toolCallId)).at(-1);
  // Its questions, or the one question of a run before then.
  const questions = clarifyQuestions(typeof asked?.input === "string" ? parsed(asked.input) : asked?.input);
  const readings = Array.isArray(accepted?.interpretation)
    ? (accepted.interpretation as unknown[]).filter((r): r is string => typeof r === "string")
    : [];
  const said = accepted
    ? ` It answered: ${cap(accepted.rendered as string, 1_500)}${readings.length ? ` Readings: ${readings.join("; ")}.` : ""}`
    : questions.length
      ? ` It asked: ${questions.map((q) => `${q.question} (${q.options.join("; ")})`).join(" ")}`
      : "";
  // The dashboards it saved, and the pages it wrote: a turn that paused mid-build answered nothing, and the run that goes
  // on needs to know where its work is (the draft is kept; dashboard_open reads it).
  const saves = new Set(
    parts.flatMap((p) => {
      const v = json(p);
      return v && typeof v.dashboard_id === "string" && v.saved === "draft" ? [p.toolCallId] : [];
    }),
  );
  const savedTo = new Map<string, string[]>();
  for (const p of parts) {
    const v = json(p);
    if (!v || typeof v.dashboard_id !== "string" || v.saved !== "draft") continue;
    if (!savedTo.has(v.dashboard_id)) savedTo.set(v.dashboard_id, []);
  }
  for (const p of parts) {
    if (p.type !== "tool-call" || !saves.has(p.toolCallId)) continue;
    const input = (typeof p.input === "string" ? parsed(p.input) : p.input) as
      | { dashboard_id?: unknown; page?: { title?: unknown } }
      | undefined;
    const id = typeof input?.dashboard_id === "string" ? input.dashboard_id : null;
    const title = typeof input?.page?.title === "string" ? input.page.title : null;
    if (id && title) savedTo.get(id)?.push(title);
  }
  const built = [...savedTo].map(
    ([id, pages]) => `dashboard ${id}${pages.length ? ` (pages saved: ${[...new Set(pages)].join(", ")})` : ""}`,
  );
  const dashboardsSaid = built.length
    ? ` It saved the draft of ${built.join("; ")}: open it with dashboard_open to go on from what's there.`
    : "";
  const unfinished = !said && (built.length || queries.length) ? " It stopped before an answer." : "";
  const body = `${queries.length ? `It ran ${queries.join("; ")} (read /results/<alias> to see one's rows again).` : "It ran no queries."}${said}${dashboardsSaid}${unfinished}`;
  return {
    role: "assistant",
    content: [
      {
        type: "text",
        text: `(Earlier work, folded to save room.)\n<context source="earlier work" trust="data">\n${inert(body)}\n</context>`,
      },
    ],
  };
}

/**
 * A result folded to what names it (its alias, title, columns, error), its rows left out: they're read back from what
 * the gateway kept (read /results/<alias>), and its cells stay citable by alias.
 */
export function shrunk(m: ModelMessage): ModelMessage {
  if (m.role !== "tool") return m;
  const content = partsOf(m).map((part) => {
    if (part.type !== "tool-result" || !part.output) return part;
    const { output } = part;
    if (output.type === "json" && output.value && typeof output.value === "object" && !Array.isArray(output.value)) {
      const v = output.value as Record<string, unknown>;
      const kept = Object.fromEntries(
        ["alias", "title", "columns", "error", "truncated"].filter((k) => k in v).map((k) => [k, v[k]]),
      );
      return {
        ...part,
        output: {
          type: "json",
          value: {
            ...kept,
            folded:
              typeof v.alias === "string"
                ? `Its rows were folded to fit: read /results/${v.alias} to see them again (nothing reruns).`
                : "Folded to fit; call it again if you need it.",
          },
        },
      };
    }
    if (output.type === "error-text" && typeof output.value === "string" && output.value.length > 300) {
      return { ...part, output: { ...output, value: `${output.value.slice(0, 300)}…` } };
    }
    return part;
  });
  return { ...m, content } as ModelMessage;
}

interface Turn {
  /** The person's message(s) that opened it. */
  asked: number[];
  /** What the agent did, notes from OpenDash and the person's follow-ups it read included, by index, in order. */
  rest: number[];
}

/** The conversation's turns, by message index: a question, then what was done about it. */
function turnsOf(messages: ModelMessage[]): { turns: Turn[]; turnOf: number[] } {
  const turns: Turn[] = [];
  const turnOf: number[] = [];
  for (const [i, m] of messages.entries()) {
    const last = turns.at(-1);
    if ((isNote(m) || isFollowUp(m)) && last) last.rest.push(i);
    else if (m.role === "user" && (!last || last.rest.length)) turns.push({ asked: [i], rest: [] });
    else if (m.role === "user" && last) last.asked.push(i);
    else if (last) last.rest.push(i);
    else turns.push({ asked: [], rest: [i] });
    turnOf.push(turns.length - 1);
  }
  return { turns, turnOf };
}

/** A question without the block it was sent with (core's withBlockOn marks it). */
const unblocked = (m: ModelMessage): ModelMessage =>
  m.role === "user" && Array.isArray(m.content) ? { ...m, content: m.content.filter((p) => !isBlock(p)) } : m;

export interface Fitted {
  messages: ModelMessage[];
  /** What the call sends, in tokens, as counted here. */
  tokens: number;
}

/**
 * The conversation fitted to the window. `fixed` is what every call sends besides it: the system blocks, the tools,
 * and the block of the question being answered, which is left out of that question's size here, so the fold never
 * depends on it (it changes from one attempt or day to the next). What gives way is decided by replaying the
 * conversation's growth, message by message: whenever it passes the limit, the oldest turns fold, then the run's own
 * earlier results shrink, until it's back under the target.
 */
export function fitted(messages: ModelMessage[], fixed: number, window: InputWindow): Fitted {
  const { turns, turnOf } = turnsOf(messages);
  const current = messages.findLastIndex((m) => m.role === "user" && !isNote(m) && !isFollowUp(m));
  const size = messages.map((m, i) => tokensOf(i === current ? unblocked(m) : m));
  /** What a turn's questions save when it folds: the blocks they were sent with. */
  const blocks = (t: number) =>
    (turns[t]?.asked ?? []).reduce(
      (n, i) => n + (size[i] as number) - tokensOf(unblocked(messages[i] as ModelMessage)),
      0,
    );
  const notes = new Map<number, number>();
  const noteSize = (t: number) => {
    if (!notes.has(t))
      notes.set(t, tokensOf(foldedNote((turns[t]?.rest ?? []).map((i) => messages[i] as ModelMessage))));
    return notes.get(t) as number;
  };
  const hasTools = (t: number) => (turns[t]?.rest ?? []).some((i) => messages[i]?.role === "tool");
  let folded = 0;
  const small = new Set<number>();
  const now = (i: number) => (small.has(i) ? tokensOf(shrunk(messages[i] as ModelMessage)) : (size[i] as number));
  let total = fixed;
  for (const [i] of messages.entries()) {
    total += size[i] as number;
    if (total <= window.limit) continue;
    const turn = turnOf[i] as number;
    // The oldest turns, each to its note.
    while (total > window.target && folded < turn) {
      if (hasTools(folded)) {
        const rest = (turns[folded] as Turn).rest;
        total += noteSize(folded) - rest.reduce((n, j) => n + now(j), 0);
      }
      total -= blocks(folded);
      folded += 1;
    }
    if (total <= window.target) continue;
    // The run's own turn: its earlier results shrink, oldest first, the latest ones kept whole.
    const results = (turns[turn] as Turn).rest.filter((j) => j <= i && messages[j]?.role === "tool");
    let recent = 0;
    const kept = new Set<number>();
    for (const j of [...results].reverse()) {
      if (kept.size && recent + now(j) > window.keepRecent) break;
      recent += now(j);
      kept.add(j);
    }
    for (const j of results) {
      if (total <= window.target) break;
      if (kept.has(j) || small.has(j)) continue;
      const before = now(j);
      if (before - tokensOf(shrunk(messages[j] as ModelMessage)) < MIN_SAVING) continue;
      small.add(j);
      total += now(j) - before;
    }
  }
  if (!folded && !small.size) return { messages, tokens: total };
  const out = turns.flatMap((turn, t) => {
    const asked = turn.asked.map((i) =>
      t < folded ? unblocked(messages[i] as ModelMessage) : (messages[i] as ModelMessage),
    );
    if (t < folded && hasTools(t)) {
      const rest = turn.rest.map((i) => messages[i] as ModelMessage);
      // What the person added while it worked stays word for word, with the question, before the note of what the agent
      // did (its answer covered both).
      return [...asked, ...rest.filter(isFollowUp), foldedNote(rest.filter((m) => !isFollowUp(m)))];
    }
    return [
      ...asked,
      ...turn.rest.map((i) => (small.has(i) ? shrunk(messages[i] as ModelMessage) : (messages[i] as ModelMessage))),
    ];
  });
  return { messages: out, tokens: total };
}

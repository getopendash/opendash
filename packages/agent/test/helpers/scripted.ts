// A scripted model for offline runs: AI SDK's mock plays the model, one step per call, everything else real.
import type {
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";

export const usage = {
  inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 100, text: 100, reasoning: 0 },
};
let callSeq = 0;
export const call = (toolName: string, input: unknown): LanguageModelV4Content => ({
  type: "tool-call",
  toolCallId: `call-${++callSeq}`,
  toolName,
  input: JSON.stringify(input),
});
export const step = (...content: LanguageModelV4Content[]): LanguageModelV4GenerateResult => ({
  content,
  finishReason: { unified: content.some((c) => c.type === "tool-call") ? "tool-calls" : "stop", raw: undefined },
  usage,
  warnings: [],
});

export type Prompt = LanguageModelV4CallOptions["prompt"];

/** A call's system blocks, as JSON: the agent layer, then the source layer. */
export const systemOf = (prompt?: Prompt) => JSON.stringify((prompt ?? []).filter((m) => m.role === "system"));

/** A call's messages, as JSON: the conversation, its question carrying what belongs to the run alone. */
export const messagesOf = (prompt?: Prompt) => JSON.stringify((prompt ?? []).filter((m) => m.role !== "system"));

/** The alias the gateway gave the query with this title, read from the tool results the model was shown. */
export function aliasOf(prompt: Prompt, title: string): string {
  for (const m of prompt) {
    if (m.role !== "tool") continue;
    for (const p of m.content) {
      const value =
        p.type === "tool-result" && p.output.type === "json"
          ? (p.output.value as { alias?: string; title?: string })
          : null;
      if (value?.title === title && value.alias) return value.alias;
    }
  }
  throw new Error(`No result titled ${title} in the prompt.`);
}

/** How big the pieces of a streamed step are: small and odd, so escapes and references split across pieces. */
export const PIECE = 7;
const pieces = (text: string) =>
  Array.from({ length: Math.ceil(text.length / PIECE) }, (_, i) => text.slice(i * PIECE, (i + 1) * PIECE));

/** A generated step as the stream a provider sends: its text, reasoning and tool inputs in pieces, then the call. */
export function streamOf(result: LanguageModelV4GenerateResult): LanguageModelV4StreamPart[] {
  const parts: LanguageModelV4StreamPart[] = [{ type: "stream-start", warnings: [] }];
  for (const [i, c] of result.content.entries()) {
    const id = `p${i}`;
    if (c.type === "text") {
      parts.push(
        { type: "text-start", id },
        ...pieces(c.text).map((delta) => ({ type: "text-delta" as const, id, delta })),
        { type: "text-end", id },
      );
    } else if (c.type === "reasoning") {
      parts.push(
        { type: "reasoning-start", id },
        ...pieces(c.text).map((delta) => ({ type: "reasoning-delta" as const, id, delta })),
        { type: "reasoning-end", id },
      );
    } else if (c.type === "tool-call") {
      parts.push(
        { type: "tool-input-start", id: c.toolCallId, toolName: c.toolName },
        ...pieces(c.input).map((delta) => ({ type: "tool-input-delta" as const, id: c.toolCallId, delta })),
        { type: "tool-input-end", id: c.toolCallId },
        c,
      );
    }
  }
  parts.push({ type: "finish", usage: result.usage, finishReason: result.finishReason });
  return parts;
}

/** A mock model's calls, answered by `gen` whether the run generates or streams (runs stream). */
export const streaming = (gen: (options: LanguageModelV4CallOptions) => Promise<LanguageModelV4GenerateResult>) => ({
  doGenerate: gen,
  doStream: async (options: LanguageModelV4CallOptions) => ({
    stream: ReadableStream.from(streamOf(await gen(options))),
  }),
});

/**
 * A scripted model: one step per model call, generated or streamed (runs stream). A function step sees the prompt (to
 * read aliases) or throws.
 */
export function scripted(
  steps: (
    | LanguageModelV4GenerateResult
    | ((prompt: Prompt) => LanguageModelV4GenerateResult | Promise<LanguageModelV4GenerateResult>)
  )[],
) {
  const prompts: LanguageModelV4CallOptions["prompt"][] = [];
  const tools: string[][] = [];
  let i = 0;
  const take = async (options: LanguageModelV4CallOptions) => {
    prompts.push(options.prompt);
    tools.push((options.tools ?? []).map((t) => t.name));
    const next = steps[i++];
    if (!next) throw new Error("The script ran out of steps.");
    return typeof next === "function" ? next(options.prompt) : next;
  };
  const model = new MockLanguageModelV4({
    doGenerate: take,
    doStream: async (options) => ({ stream: ReadableStream.from(streamOf(await take(options))) }),
  });
  return { model, prompts, tools };
}

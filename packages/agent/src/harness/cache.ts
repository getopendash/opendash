/**
 * Where the prompt cache holds. Anthropic caches a request's prefix up to each cache point, in the order
 * tools, then system, then messages, with at most four points; a provider that caches prefixes by itself (OpenAI,
 * Google) gains from the same order. The four:
 *   1. after the agent layer, the first system block: the tools and the agent's rules for its database, the same for
 *      every run of that agent on that database (the analyst's in two versions, as its tools are: a source with
 *      verified metrics or without);
 *   2. after the source layer, the second: catalog, metrics, glossary, guides, skills, other sources, until a sync or
 *      a definition changes them;
 *   3. on the conversation as the previous step left it, so this step reads what that one wrote, however many blocks
 *      it added (the provider looks back only 20 blocks from a point for a hit);
 *   4. on the last message, so the next step reads this one.
 * What belongs to the conversation (what's attached to it, the asker's memory) is a third system block, rebuilt every
 * run and never stored, with no point of its own: points 3 and 4 cover it while it stays the same. What belongs to one
 * question (the date, the insight it checks, the verified queries like it) goes with that question, and is sent again
 * with it on the next question, so the conversation reads the same and its cache holds. Nothing that
 * changes during a run moves the cache: the tools, the system text and the thinking settings stay the same, so wrapping
 * up says so in a message instead (policy.ts).
 *
 * Every point lives 5 minutes, refreshed by each read. A 1-hour point would carry the source layer between questions
 * minutes apart, but it costs twice a 5-minute write, and the usage the provider reports doesn't say which kind a
 * write was, so its price (usage/prices.ts) would be wrong. That waits for a measured case.
 */
import type { ModelMessage, SystemModelMessage } from "ai";
import type { Layer } from "../instructions/compose";

/** A cache point (Anthropic's cache_control): the prompt up to here is cached for 5 minutes, refreshed on each read. */
export const CACHED = { anthropic: { cacheControl: { type: "ephemeral" } } } as const;

/** The system prompt: the agent layer and the source layer, each a cache point, then the conversation layer. */
export function systemBlocks(layers: Record<Layer, string>, conversation = ""): SystemModelMessage[] {
  const cached = [layers.agent, layers.source]
    .filter((text) => text.trim() !== "")
    .map((content): SystemModelMessage => ({ role: "system", content, providerOptions: CACHED }));
  return conversation.trim() ? [...cached, { role: "system", content: conversation }] : cached;
}

type Options = Record<string, Record<string, unknown>>;

/** A message with its own cache point set, or cleared; anything else it carries for a provider is kept. */
function pointed(m: ModelMessage, on: boolean): ModelMessage {
  const options = (m.providerOptions ?? {}) as Options;
  const { cacheControl: _old, ...anthropic } = options.anthropic ?? {};
  const rest = Object.fromEntries(Object.entries(options).filter(([name]) => name !== "anthropic"));
  const next: Options = {
    ...rest,
    ...(on ? { anthropic: { ...anthropic, ...CACHED.anthropic } } : Object.keys(anthropic).length ? { anthropic } : {}),
  };
  const { providerOptions: _dropped, ...bare } = m;
  return (Object.keys(next).length ? { ...bare, providerOptions: next } : bare) as ModelMessage;
}

/**
 * The conversation with its two cache points: on the last message, and on the last message before the model's latest
 * turn (where the previous step put its own). Points from earlier steps are cleared: the SDK carries each step's
 * messages into the next, and a fifth point would be dropped.
 */
export function withCachePoints(messages: ModelMessage[]): ModelMessage[] {
  const last = messages.length - 1;
  const latestTurn = messages.findLastIndex((m) => m.role === "assistant");
  const previous = latestTurn > 0 ? latestTurn - 1 : -1;
  return messages.map((m, i) => pointed(m, i === last || i === previous));
}

/**
 * A conversation can change model and provider between questions, so a rebuilt transcript can
 * hold turns from another route. A provider's reasoning (Anthropic's signed thinking, OpenAI's encrypted reasoning,
 * Google's thought signatures) can only go back the way it came: Claude's thinking signed through Bedrock isn't
 * Anthropic's own, though both carry it under `anthropic`. So each part the model produced is tagged with its route
 * when it's committed (commit.ts), and for the route this run uses, reasoning parts from another route are left out
 * and other routes' metadata is stripped from the rest. The answers, tool calls and results stay. A part from before
 * the tag was its maker's own API, the one its metadata is named for.
 */
import type { ModelMessage } from "ai";
import type { Route } from "../providers/build";

type Part = { type: string; providerOptions?: Record<string, unknown> };

/** A part's options with its route's tag, for the next time the transcript is rebuilt. */
export function tagged(options: Record<string, unknown> | undefined, route: Route): Record<string, unknown> {
  const own = (options?.opendash as Record<string, unknown> | undefined) ?? {};
  return { ...(options ?? {}), opendash: { ...own, route } };
}

/** The options a part keeps on this route: only `keep`'s namespaces, and OpenDash's own marks. */
function only(part: Part, keep: (name: string) => boolean): Part {
  const options = part.providerOptions as Record<string, unknown>;
  const kept = Object.fromEntries(Object.entries(options).filter(([name]) => name === "opendash" || keep(name)));
  const { providerOptions: _dropped, ...rest } = part;
  return Object.keys(kept).length ? { ...rest, providerOptions: kept } : rest;
}

function forPart(part: Part, route: Route): Part[] {
  const options = part.providerOptions;
  // Reasoning nobody can vouch for (no route, no signature) never goes back.
  if (!options) return part.type === "reasoning" ? [] : [part];
  const tag = (options.opendash as { route?: unknown } | undefined)?.route;
  if (typeof tag === "string") {
    if (tag === route) return [part];
    return part.type === "reasoning" ? [] : [only(part, () => false)];
  }
  // From before the tag: a part's metadata is named for the maker's own API it came by.
  if (part.type === "reasoning" && !(route in options)) return [];
  return [only(part, (name) => name === route)];
}

export function forRoute(messages: ModelMessage[], route: Route): ModelMessage[] {
  return messages.flatMap((m) => {
    if (m.role !== "assistant" || typeof m.content === "string") return [m];
    const content = (m.content as Part[]).flatMap((p) => forPart(p, route));
    // An assistant turn that was only another route's reasoning has nothing left to say.
    return content.length ? [{ ...m, content } as ModelMessage] : [];
  });
}

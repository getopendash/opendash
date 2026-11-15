/**
 * What happens when a model call ends (onLanguageModelCallEnd), before any of its tool calls run: what it streamed goes
 * out, its assistant message and usage are committed (a failed commit aborts the attempt, since the SDK swallows errors
 * thrown here), its cost counts toward the agent's budget, and a call the SDK couldn't parse is recorded with its
 * error so the transcript is whole.
 */
import { commitAssistantMessage, costOf, finishToolCall, startToolCall } from "@opendash/core";
import type { LanguageModelCallEndEvent } from "ai";
import type { Route } from "../providers/build";
import type { AttemptScope } from "./attempt";
import type { ResolvedModel } from "./model";
import type { RunDeltas } from "./stream";
import { CUT_SHORT } from "./tool-runner";
import { tagged } from "./transcript";

type ContentPart = LanguageModelCallEndEvent["content"][number];

/**
 * The call's content parts as the assistant message the model will see next time, signatures included, each tagged
 * with the route it came by (transcript.ts): its reasoning goes back only that way.
 */
function assistantContent(parts: readonly ContentPart[], route: Route) {
  const out: Record<string, unknown>[] = [];
  for (const p of parts) {
    const metadata = "providerMetadata" in p && p.providerMetadata ? p.providerMetadata : undefined;
    const providerOptions =
      metadata || p.type === "reasoning" ? { providerOptions: tagged(metadata as Record<string, unknown>, route) } : {};
    if (p.type === "text" && p.text) out.push({ type: "text", text: p.text, ...providerOptions });
    else if (p.type === "reasoning") out.push({ type: "reasoning", text: p.text, ...providerOptions });
    else if (p.type === "tool-call") {
      out.push({
        type: "tool-call",
        toolCallId: p.toolCallId,
        toolName: p.toolName,
        input: p.input ?? {},
        ...providerOptions,
      });
    }
  }
  return out;
}

/** Less than this lost from the cache is noise (a provider's block rounding), not a miss. */
const MISS_TOKENS = 1024;
/** How long a provider keeps a cached prefix without use (Anthropic's default): past it, a miss is the wait's. */
const CACHE_TTL_MS = 5 * 60_000;

/**
 * Whether this call read back less from the cache than the call before it left there, and why:
 * a fold since (its prefix changed), a wait past the cache's life, or neither ("unexplained": a prefix that should have
 * held and didn't). Within an attempt only; it remembers this call's for the next.
 */
export function cacheMissOf(
  scope: Pick<AttemptScope, "lastCache" | "prefixBroke" | "log" | "run">,
  ev: { usage: { inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number } } },
  now = Date.now(),
): { lostTokens: number; cause: "folded" | "idle" | "unexplained" } | null {
  const read = ev.usage.inputTokenDetails?.cacheReadTokens ?? 0;
  const written = ev.usage.inputTokenDetails?.cacheWriteTokens ?? 0;
  const before = scope.lastCache;
  scope.lastCache = { tokens: read + written, at: now };
  if (!before || before.tokens - read <= MISS_TOKENS) return null;
  const cause = scope.prefixBroke ?? (now - before.at > CACHE_TTL_MS ? "idle" : "unexplained");
  const miss = { lostTokens: before.tokens - read, cause } as const;
  scope.log("cache miss", { runId: scope.run.id, ...miss });
  return miss;
}

export function onCallEnd(scope: AttemptScope, resolved: ResolvedModel, deltas: RunDeltas | null) {
  const { deps, run, state } = scope;
  return async (ev: LanguageModelCallEndEvent) => {
    try {
      // What this call streamed goes out before its message is committed; its tail is dropped.
      await deltas?.endCall();
      scope.steps += 1;
      const text = ev.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
      const miss = cacheMissOf(scope, ev);
      const reasoning = ev.content.flatMap((p) => (p.type === "reasoning" ? [p.text] : [])).join("\n");
      const messageId = await commitAssistantMessage(deps, run, {
        content: assistantContent(ev.content, resolved.route),
        text,
        reasoning,
        usage: {
          inputTokens: ev.usage.inputTokens ?? 0,
          outputTokens: ev.usage.outputTokens ?? 0,
          reasoningTokens: ev.usage.outputTokenDetails?.reasoningTokens ?? 0,
          cachedInputTokens: ev.usage.inputTokenDetails?.cacheReadTokens ?? 0,
          cacheWriteTokens: ev.usage.inputTokenDetails?.cacheWriteTokens ?? 0,
          ...(ev.usage.inputTokenDetails?.noCacheTokens !== undefined
            ? { noCacheTokens: ev.usage.inputTokenDetails.noCacheTokens }
            : {}),
          ...(miss ? { cacheMiss: miss } : {}),
        },
        finishReason: ev.finishReason,
        provider: resolved.provider,
        keySource: resolved.keySource,
      });
      // What this call cost, for an agent's dollar budget (priced models; another's calls count nothing).
      const read = ev.usage.inputTokenDetails?.cacheReadTokens ?? 0;
      const written = ev.usage.inputTokenDetails?.cacheWriteTokens ?? 0;
      state.costUsd +=
        costOf(run.model, {
          noCacheTokens:
            ev.usage.inputTokenDetails?.noCacheTokens ?? Math.max(0, (ev.usage.inputTokens ?? 0) - read - written),
          cacheReadTokens: read,
          cacheWriteTokens: written,
          outputTokens: ev.usage.outputTokens ?? 0,
        }) ?? 0;
      const calls = ev.content.filter((p) => p.type === "tool-call");
      // A response cut off at its output limit: its calls' input may be cut short and still parse, so none runs.
      if (ev.finishReason === "length" && calls.length) {
        for (const p of calls) scope.cut.add(p.toolCallId);
        scope.cutShort = true;
      }
      scope.malformed = calls.length && calls.every((p) => p.invalid) ? scope.malformed + 1 : 0;
      for (const p of ev.content) {
        if (p.type !== "tool-call" || !messageId) continue;
        scope.committed.set(p.toolCallId, messageId);
        // A call that never reaches execute (the SDK couldn't parse it, or its response was cut off at its output
        // limit, which the SDK doesn't run) is recorded with why, so the transcript is whole. A cut-off call is told
        // so even when its input no longer parses: being cut off is why.
        const cutShort = scope.cut.has(p.toolCallId);
        if (p.invalid || cutShort) {
          const message = cutShort
            ? CUT_SHORT
            : `The input for ${p.toolName} didn't match its schema: ${String(p.error ?? "invalid input")}`;
          await startToolCall(deps, run, {
            callId: p.toolCallId,
            tool: p.toolName,
            effect: scope.prepared.tools.find((t) => t.name === p.toolName)?.effect ?? "read",
            args: p.input ?? {},
            messageId,
          });
          await finishToolCall(deps, run, {
            callId: p.toolCallId,
            tool: p.toolName,
            outcome: { ok: false, error: message },
          });
          scope.recorded.set(p.toolCallId, message);
        }
      }
    } catch (error) {
      // The SDK swallows errors thrown here; aborting is what stops the loop.
      scope.ctl.abort(error);
      throw error;
    }
  };
}

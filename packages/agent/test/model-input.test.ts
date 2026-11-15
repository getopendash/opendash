// What the model is sent, pinned: the system prompt and where its cache points are, the tools (names, descriptions,
// JSON schemas, in order) and the provider options of the first call of a run. A change here changes what the model reads (and its prompt cache), so
// it has to be meant: the snapshot makes it visible in review. Two sources: the demo with its pack verified (every
// tool), and a fresh one with no verified metrics.
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { catalogModel, DEFAULT_MODEL, demoPack, effortOf, installDefinitions, submitQuestion } from "@opendash/core";
import { type LearnedSource, learnedSource } from "@opendash/core/testing";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AgentDeps, callOptions, runAttempt } from "../src";
import { streaming } from "./helpers/scripted";

let withMetrics: LearnedSource;
let without: LearnedSource;
const NOW = new Date("2026-10-10T12:00:00Z");

beforeAll(async () => {
  // One at a time: two learned at once grant on the same roles concurrently, which Postgres refuses.
  withMetrics = await learnedSource();
  without = await learnedSource();
  await withMetrics.tenant((tx) =>
    installDefinitions(
      tx,
      { orgId: withMetrics.orgId, userId: withMetrics.userId },
      withMetrics.connectionId,
      demoPack("postgres"),
      { status: "verified", source: "pack" },
    ),
  );
}, 300_000);

afterAll(async () => {
  await Promise.all([withMetrics?.close(), without?.close()]);
});

/** Runs one question whose model only clarifies, and returns what its first call was sent and the source's name. */
async function firstCall(s: LearnedSource): Promise<{ options: LanguageModelV4CallOptions; sourceName: string }> {
  const calls: LanguageModelV4CallOptions[] = [];
  const model = new MockLanguageModelV4(
    streaming(async (options) => {
      calls.push(options);
      return {
        content: [
          {
            type: "tool-call",
            toolCallId: `clarify-${calls.length}`,
            toolName: "clarify",
            input: JSON.stringify({ question: "Which one?", options: ["A", "B"] }),
          },
        ],
        finishReason: { unified: "tool-calls", raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      };
    }),
  );
  const deps: AgentDeps = {
    withTenant: s.deps.withTenant,
    secrets: s.secrets,
    edition: "community",
    model: async () => ({
      model,
      provider: "opendash",
      route: "anthropic",
      ...callOptions("anthropic", catalogModel(DEFAULT_MODEL) as never, effortOf(DEFAULT_MODEL, "high")),
      keySource: "deployment",
    }),
    now: () => NOW,
  };
  const { runId } = await submitQuestion(
    { withTenant: s.deps.withTenant, boss: null },
    {
      orgId: s.orgId,
      userId: s.userId,
      connectionId: s.connectionId,
      text: "How did MRR change last month?",
      channel: "eval",
      model: "mock",
    },
  );
  await runAttempt(deps, { orgId: s.orgId, runId }, { workerId: "snapshot" });
  const first = calls[0];
  if (!first) throw new Error("The model was never called.");
  const [c] = await s.t.owner<{ name: string }[]>`select name from app.connection where id = ${s.connectionId}`;
  return { options: first, sourceName: c?.name ?? "" };
}

/**
 * The parts of a call that the model reads, in a stable shape (no ids, no source names that differ per test): the
 * system blocks' text (the agent layer, then the source layer), each block's provider options, where its cache point is
 * set, and the question with its own.
 */
function modelInput(options: LanguageModelV4CallOptions, sourceName: string) {
  const blocks = options.prompt.filter((m) => m.role === "system");
  return {
    system: blocks
      .map((b) => (typeof b.content === "string" ? b.content : ""))
      .join("\n\n<next block>\n\n")
      .replaceAll(sourceName, "<source>"),
    systemProviderOptions: blocks.map((b) => b.providerOptions ?? null),
    // The question, with what belongs to this run alone (the date), and its cache point.
    messages: options.prompt
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: m.content, providerOptions: m.providerOptions ?? null })),
    tools: (options.tools ?? []).map((t) =>
      t.type === "function"
        ? { name: t.name, description: t.description, inputSchema: t.inputSchema }
        : { name: t.name, type: t.type },
    ),
    reasoning: options.reasoning,
    providerOptions: options.providerOptions,
  };
}

describe("what the model is sent", () => {
  it("on a source with verified metrics", async () => {
    const { options, sourceName } = await firstCall(withMetrics);
    await expect(JSON.stringify(modelInput(options, sourceName), null, 2)).toMatchFileSnapshot(
      "./__snapshots__/model-input.metrics.json",
    );
  });

  it("on a source with none", async () => {
    const { options, sourceName } = await firstCall(without);
    await expect(JSON.stringify(modelInput(options, sourceName), null, 2)).toMatchFileSnapshot(
      "./__snapshots__/model-input.plain.json",
    );
  });
});

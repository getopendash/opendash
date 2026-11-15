// Traces: with an exporter registered, an attempt is one `agent.run` span with the AI SDK's model
// and tool spans and the gateway's query spans under it, and none of them carries the question, the SQL or the answer.
// Its own file: the tracer provider and the AI SDK integration are registered for the whole process.

import { OpenTelemetry } from "@ai-sdk/otel";
import type { LanguageModelV4Content, LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import { submitQuestion } from "@opendash/core";
import { type LearnedSource, learnedSource } from "@opendash/core/testing";
import { MRR_SQL } from "@opendash/evals";
import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { registerTelemetry } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type AgentDeps, runAttempt } from "../src";
import { streaming } from "./helpers/scripted";

const exporter = new InMemorySpanExporter();
let s: LearnedSource;
const QUESTION = "How much MRR did we have at the end of September?";

beforeAll(async () => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }));
  registerTelemetry(new OpenTelemetry());
  s = await learnedSource();
}, 300_000);

afterAll(async () => {
  await s?.close();
});

const usage = {
  inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 100, text: 100, reasoning: 0 },
};
const step = (...content: LanguageModelV4Content[]): LanguageModelV4GenerateResult => ({
  content,
  finishReason: { unified: content.some((c) => c.type === "tool-call") ? "tool-calls" : "stop", raw: undefined },
  usage,
  warnings: [],
});
const call = (toolName: string, input: unknown, id: string): LanguageModelV4Content => ({
  type: "tool-call",
  toolCallId: id,
  toolName,
  input: JSON.stringify(input),
});

it("traces an attempt with its model, tool and query spans nested, and records none of what was asked or found", async () => {
  const q = await submitQuestion(
    { withTenant: s.deps.withTenant, boss: null },
    { orgId: s.orgId, userId: s.userId, connectionId: s.connectionId, text: QUESTION, channel: "eval", model: "mock" },
  );
  const steps = [
    step(
      call(
        "sql_query",
        { title: "MRR end of September", sql: MRR_SQL, params: [{ name: "as_of", value: "2026-10-01T00:00:00Z" }] },
        "c1",
      ),
    ),
    step(
      call(
        "sql_query",
        {
          title: "MRR, summed another way",
          sql: `select sum(mrr) as mrr from (${MRR_SQL}) x`,
          params: [{ name: "as_of", value: "2026-10-01T00:00:00Z" }],
        },
        "c2",
      ),
    ),
    step(
      call(
        "answer",
        {
          status: "answered",
          markdown: "MRR was ⟦q1:0:mrr|currency:USD,compact⟧.",
          interpretation: [],
          caveats: [],
          cross_checks: [{ headline: "q1:0:mrr", check: "q2:0:mrr" }],
        },
        "c3",
      ),
    ),
  ];
  let i = 0;
  const model = new MockLanguageModelV4(
    streaming(async () => {
      const next = steps[i++];
      if (!next) throw new Error("The script ran out of steps.");
      return next;
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
      providerOptions: {},
      keySource: "deployment",
    }),
  };
  expect(await runAttempt(deps, { orgId: s.orgId, runId: q.runId }, { workerId: "t" })).toMatchObject({
    status: "succeeded",
  });

  const spans = exporter.getFinishedSpans();
  const run = spans.find((x) => x.name === "agent.run");
  expect(run?.attributes).toMatchObject({
    "opendash.run_id": q.runId,
    "opendash.org_id": s.orgId,
    "opendash.model": "mock",
    "opendash.status": "succeeded",
    "opendash.outcome": "answer",
  });
  const runId = run?.spanContext().spanId;
  const traceId = run?.spanContext().traceId;
  const query = spans.find((x) => x.name === "gateway.query");
  expect(query?.attributes).toMatchObject({
    "db.system": "postgres",
    "opendash.status": "succeeded",
    "opendash.rows": 1,
  });
  // Every span of the attempt is in its trace: the AI SDK's included, and the query under a tool's span.
  const sdk = spans.filter((x) => x !== run && x !== query && x.spanContext().traceId === traceId);
  expect(sdk.length).toBeGreaterThan(0);
  expect(query?.spanContext().traceId).toBe(traceId);
  expect(spans.some((x) => x.parentSpanContext?.spanId === runId && x !== query)).toBe(true);
  // Nothing of the question, the SQL or the answer is in any span.
  const recorded = JSON.stringify(spans.map((x) => ({ name: x.name, attributes: x.attributes, events: x.events })));
  expect(recorded).not.toContain(QUESTION);
  expect(recorded).not.toContain("MRR end of September");
  expect(recorded).not.toContain(MRR_SQL.slice(0, 40));
  expect(recorded).not.toContain("MRR was");
});

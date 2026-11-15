/**
 * The AI SDK's spans, for a process that exports OpenTelemetry: model calls, steps and tool calls,
 * nested under the run's own span. Every call the analyst makes turns off recording its inputs and outputs, so spans
 * carry timings, usage and ids, never a question, prompt or answer.
 */
import { OpenTelemetry } from "@ai-sdk/otel";
import { registerTelemetry } from "ai";

export function enableAiTelemetry(): void {
  registerTelemetry(new OpenTelemetry());
}

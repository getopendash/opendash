/**
 * OpenTelemetry for the worker, opt-in: with OTEL_EXPORTER_OTLP_ENDPOINT set, it exports traces
 * over OTLP/HTTP (the exporter reads the standard OTEL_EXPORTER_OTLP_* variables). A run's `agent.run` span holds the
 * AI SDK's model and tool spans and the gateway's query spans; pg-boss adds its own. Traces only, and without the
 * variable nothing is started.
 */

import { enableAiTelemetry } from "@opendash/agent";
import { ScrubbingSpanProcessor } from "@opendash/core/telemetry";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

export function startTelemetry(service = "opendash-worker"): { shutdown(): Promise<void> } | null {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim()) return null;
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ "service.name": process.env.OTEL_SERVICE_NAME?.trim() || service }),
    // Scrubbed before export: no query strings, no error messages (a model's or a driver's can quote data).
    spanProcessors: [new ScrubbingSpanProcessor(), new BatchSpanProcessor(new OTLPTraceExporter())],
  });
  // The global tracer provider, and the async context that nests a run's spans.
  provider.register();
  enableAiTelemetry();
  return provider;
}

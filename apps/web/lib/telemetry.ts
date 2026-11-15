import "server-only";
import { ScrubbingSpanProcessor } from "@opendash/core/telemetry";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, type SpanExporter } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

/**
 * OpenTelemetry for the web app, opt-in like the worker's: with
 * OTEL_EXPORTER_OTLP_ENDPOINT set, Next.js's own request and render spans are exported over OTLP/HTTP, each scrubbed
 * first (`@opendash/core/telemetry`: no query strings, no error messages).
 */
export function startWebTelemetry(exporter?: SpanExporter): NodeTracerProvider | null {
  // A test passes its own exporter; otherwise nothing starts without an endpoint.
  if (!exporter && !process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim()) return null;
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ "service.name": process.env.OTEL_SERVICE_NAME?.trim() || "opendash-web" }),
    spanProcessors: [new ScrubbingSpanProcessor(), new BatchSpanProcessor(exporter ?? new OTLPTraceExporter())],
  });
  provider.register();
  return provider;
}

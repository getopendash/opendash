// The web app's traces: Next.js's spans leave without their query strings, which can hold a
// question or an unsubscribe token.
import { trace } from "@opentelemetry/api";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { startWebTelemetry } = await import("../lib/telemetry");

const exporter = new InMemorySpanExporter();
const provider = startWebTelemetry(exporter);

afterAll(async () => {
  await provider?.shutdown();
});

describe("web traces", () => {
  it("keep paths and routes, and drop query strings from attributes and names", async () => {
    const tracer = trace.getTracer("test");
    tracer
      .startSpan("GET /unsubscribe?t=the-token", {
        attributes: {
          "http.method": "GET",
          "http.target": "/ask/new?q=Why%20did%20churn%20drop&source=c1",
          "http.url": "https://app.opendash.example/unsubscribe?t=the-token",
          "url.query": "t=the-token",
          "next.route": "/ask/new",
          "http.status_code": 200,
          other: "https://app.opendash.example/x?secret=1",
        },
      })
      .end();
    await provider?.forceFlush();
    const [span] = exporter.getFinishedSpans();
    expect(span?.name).toBe("GET /unsubscribe");
    expect(span?.attributes).toEqual({
      "http.method": "GET",
      "http.target": "/ask/new",
      "http.url": "https://app.opendash.example/unsubscribe",
      "next.route": "/ask/new",
      "http.status_code": 200,
      other: "https://app.opendash.example/x",
    });
    const sent = exporter.getFinishedSpans().map((x) => ({ name: x.name, attributes: x.attributes }));
    expect(JSON.stringify(sent)).not.toMatch(/the-token|churn|secret/);
  });

  it("keep an error's type and code, never its message or stack", async () => {
    exporter.reset();
    const span = trace.getTracer("test").startSpan("render route (app) /ask/[id]");
    span.recordException(new Error("No user maya@acme.example for /unsubscribe?t=the-token"));
    span.setStatus({ code: 2, message: "No user maya@acme.example" });
    span.end();
    await provider?.forceFlush();
    const [done] = exporter.getFinishedSpans();
    expect(done?.status).toEqual({ code: 2 });
    expect(done?.events.map((e) => e.attributes)).toEqual([{ "exception.type": "Error" }]);
    const sent = JSON.stringify({ events: done?.events, status: done?.status, attributes: done?.attributes });
    expect(sent).not.toMatch(/maya|the-token/);
  });
});

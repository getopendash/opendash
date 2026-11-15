import type { Instrumentation } from "next";

/** Runs once when the server starts, never during `next build`. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NEXT_PHASE === "phase-production-build") return;
  // Traces, when an OTLP endpoint is set: in development too, for checking them locally.
  if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim()) {
    const { startWebTelemetry } = await import("./lib/telemetry");
    startWebTelemetry();
  }
  if (process.env.NODE_ENV !== "production") return;
  const { checkStartup } = await import("./instrumentation-node");
  await checkStartup();
}

/**
 * An error the server didn't handle (a page's render, a route, a server action), reported to PostHog when POSTHOG_KEY is
 * set (`@opendash/core`'s trackServerError): its type, stack frames, digest and the route's template, never its
 * message. Next.js logs it as before; the digest finds that log line.
 */
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs" || !process.env.POSTHOG_KEY?.trim()) return;
  const { trackServerError } = await import("@opendash/core");
  await trackServerError({ error, route: context.routePath, kind: context.routeType, method: request.method });
};

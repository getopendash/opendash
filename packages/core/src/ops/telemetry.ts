/**
 * What leaves in a trace: a span processor for the web app and the worker that runs before the
 * exporter. Query strings never leave (they can hold a question, `/ask/new?q=`, or an unsubscribe token, `?t=`): every
 * URL-like attribute and span name is cut at its `?`, and `url.query` is dropped. Nor do error messages: an exception
 * event keeps only its type, and a span's status only its code, since a message can quote a value, an address or a
 * URL. Structural types only, so it needs no OpenTelemetry package of its own (`@opendash/core/telemetry`).
 */

/** The parts of an ended span (the SDK's ReadableSpan) this changes, in place, before it's exported. */
export interface ScrubbableSpan {
  name: string;
  attributes: object;
  events: readonly { attributes?: object }[];
  status: { code: number; message?: string };
}

const URLISH = /^(http\.(target|url|route)|url\.(full|path)|next\.(route|span_name)|server\.address)$/;
const MESSAGES = new Set(["exception.message", "exception.stacktrace", "exception.escaped"]);

function scrubAttributes(attributes: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(attributes)) {
    if (key === "url.query" || MESSAGES.has(key)) delete attributes[key];
    else if (typeof value === "string" && value.includes("?") && (URLISH.test(key) || /^https?:\/\//.test(value))) {
      attributes[key] = value.slice(0, value.indexOf("?"));
    }
  }
}

export function scrubSpan(span: ScrubbableSpan): void {
  scrubAttributes(span.attributes as Record<string, unknown>);
  for (const event of span.events) {
    if (event.attributes) scrubAttributes(event.attributes as Record<string, unknown>);
  }
  if (span.status.message) span.status.message = undefined;
  if (span.name.includes("?")) span.name = span.name.slice(0, span.name.indexOf("?"));
}

/** The processor (an SDK SpanProcessor by shape): register it before the exporting one. */
export class ScrubbingSpanProcessor {
  onStart(): void {}
  onEnd(span: ScrubbableSpan): void {
    scrubSpan(span);
  }
  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

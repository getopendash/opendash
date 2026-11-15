/**
 * Product analytics: a few moments of the funnel (signed up, made a workspace, connected a source, asked, published a
 * dashboard, invited someone) and the server's errors, sent to PostHog. Off unless POSTHOG_KEY is set: a self-hosted
 * install sends nothing (docs/operations/LICENSING.md §6), and OpenDash Cloud sets it.
 *
 * What leaves is ids and a few fixed words, never a person's name or email, a question, SQL, a value or a title. An
 * error keeps its type and stack frames (file, line, function), never its message, as in a trace (`./telemetry`).
 *
 * Each send is bounded (BUDGETS.analytics.sendMs). A failed one is logged and dropped, never thrown or rejected: the
 * action it describes has already happened, so a caller in someone's request doesn't wait for it (`void track(…)`).
 * Not an outbox effect, since nothing depends on it arriving.
 *
 * The worker sends too, with the same POSTHOG_KEY: how a question ended (question_finished), each new alert
 * (alert_raised: a dead letter, a stuck run, missing partitions, a spend limit) and the error that stops it.
 */
import { BUDGETS } from "../budgets";
import { logger } from "./log";

export type AnalyticsEventName =
  | "signed_up"
  | "workspace_created"
  | "teammate_invited"
  | "invitation_accepted"
  | "source_connected"
  | "question_asked"
  | "question_finished"
  | "alert_raised"
  | "dashboard_published";

/** Property values are fixed words, counts and flags: never text someone typed. */
export type AnalyticsProperties = Record<string, string | number | boolean | null>;

export interface AnalyticsEvent {
  event: AnalyticsEventName;
  /** Who did it, or null for a workspace's API key. */
  userId: string | null;
  /** The workspace it happened in, as PostHog's `workspace` group. */
  orgId?: string | null;
  properties?: AnalyticsProperties;
}

/** PostHog's EU cloud (Frankfurt) unless POSTHOG_HOST names another, such as a PostHog of your own. */
export const DEFAULT_POSTHOG_HOST = "https://eu.i.posthog.com";

export interface AnalyticsConfig {
  key: string;
  /** Where events go, without a trailing slash. */
  host: string;
}

/** POSTHOG_KEY and POSTHOG_HOST, or null when analytics is off (no key). */
export function analyticsConfig(env: NodeJS.ProcessEnv = process.env): AnalyticsConfig | null {
  const key = env.POSTHOG_KEY?.trim();
  if (!key) return null;
  const host = (env.POSTHOG_HOST?.trim() || DEFAULT_POSTHOG_HOST).replace(/\/+$/, "");
  return { key, host };
}

/** The host PostHog serves its browser scripts from: its own assets host on PostHog Cloud, else the same one. */
export function analyticsAssetsHost(host: string): string {
  return host.replace(/^https:\/\/(eu|us)\.i\.posthog\.com$/, "https://$1-assets.i.posthog.com");
}

type Send = (url: string, init: RequestInit) => Promise<Response>;

async function capture(
  config: AnalyticsConfig,
  body: { event: string; distinct_id: string; properties: Record<string, unknown> },
  send: Send,
): Promise<void> {
  try {
    const res = await send(`${config.host}/i/v0/e/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: config.key, timestamp: new Date().toISOString(), ...body }),
      signal: AbortSignal.timeout(BUDGETS.analytics.sendMs),
    });
    if (!res.ok) logger.warn("analytics event not sent", { event: body.event, status: res.status });
  } catch (error) {
    logger.warn("analytics event not sent", {
      event: body.event,
      error: error instanceof Error ? error.name : "unknown",
    });
  }
}

/** Without a person, events are the workspace's or the server's own, with no person profile made for them. */
const anonymous = (orgId: string | null | undefined) => ({
  distinct_id: orgId ? `workspace:${orgId}` : "opendash-server",
  person: false,
});

/** Records one moment of the funnel. Does nothing without POSTHOG_KEY. */
export async function track(
  e: AnalyticsEvent,
  options: { config?: AnalyticsConfig | null; send?: Send } = {},
): Promise<void> {
  const config = options.config === undefined ? analyticsConfig() : options.config;
  if (!config) return;
  const who = e.userId ? { distinct_id: e.userId, person: true } : anonymous(e.orgId);
  await capture(
    config,
    {
      event: e.event,
      distinct_id: who.distinct_id,
      properties: {
        ...e.properties,
        ...(e.orgId ? { $groups: { workspace: e.orgId } } : {}),
        $process_person_profile: who.person,
        $lib: "opendash-server",
      },
    },
    options.send ?? fetch,
  );
}

/** One frame of a V8 stack trace ("at fn (file:line:col)" or "at file:line:col"), as PostHog's raw frames take it. */
export interface StackFrame {
  platform: "node:javascript";
  function: string;
  filename: string;
  lineno: number;
  colno: number;
  in_app: boolean;
}

const FRAME = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/;

/** The frames of an error's stack, oldest call first (PostHog's order), without the message line above them. */
export function stackFrames(stack: string | undefined): StackFrame[] {
  if (!stack) return [];
  const frames: StackFrame[] = [];
  for (const line of stack.split("\n")) {
    const m = FRAME.exec(line);
    if (!m) continue;
    const filename = m[2] ?? "";
    frames.push({
      platform: "node:javascript",
      function: m[1] ?? "?",
      filename,
      lineno: Number(m[3]),
      colno: Number(m[4]),
      in_app: !filename.includes("node_modules") && !filename.startsWith("node:"),
    });
  }
  return frames.reverse();
}

export interface ServerError {
  error: unknown;
  /** Where it happened, as a route's template ("/dashboards/[id]"): never the path itself, which carries ids. */
  route?: string | null;
  /** What was being done: render, route, action, middleware, proxy; or the worker's "unhandled_rejection". */
  kind?: string | null;
  method?: string | null;
  /** Which process it stopped in. */
  service?: "web" | "worker";
  /** How it was caught, as PostHog's mechanism. */
  mechanism?: string;
}

/** Reports an error the server didn't handle, as PostHog's `$exception`. Does nothing without POSTHOG_KEY. */
export async function trackServerError(
  e: ServerError,
  options: { config?: AnalyticsConfig | null; send?: Send } = {},
): Promise<void> {
  const config = options.config === undefined ? analyticsConfig() : options.config;
  if (!config) return;
  const err = e.error as { name?: unknown; stack?: unknown; digest?: unknown } | null;
  const type = err && typeof err.name === "string" && err.name ? err.name : "Error";
  await capture(
    config,
    {
      event: "$exception",
      distinct_id: "opendash-server",
      properties: {
        $exception_list: [
          {
            type,
            // The message is left out on purpose: it can quote a value, an address or SQL. The digest finds it in
            // the server's own logs.
            value: "",
            mechanism: { type: e.mechanism ?? "onrequesterror", handled: false },
            stacktrace: { type: "raw", frames: stackFrames(typeof err?.stack === "string" ? err.stack : undefined) },
          },
        ],
        digest: err && typeof err.digest === "string" ? err.digest : null,
        route: e.route ?? null,
        kind: e.kind ?? null,
        method: e.method ?? null,
        service: e.service ?? "web",
        $process_person_profile: false,
        $lib: "opendash-server",
      },
    },
    options.send ?? fetch,
  );
}

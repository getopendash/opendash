import { type NextRequest, NextResponse } from "next/server";
import { pagePolicy } from "./lib/frames-origin";

/**
 * Addresses the app moved from (OPENDASH_OLD_HOSTS: comma-separated host names, such as `go.example.com`). A page asked
 * for on one opens at the same path and query on the app's own address (BETTER_AUTH_URL): links in old emails, Slack
 * messages and bookmarks keep working, and every page lives on the one address its sign-in cookie and its Apps' frames
 * belong to. Only page loads move (GET and HEAD outside /api/): what other services call there (Slack's events, a
 * sign-in coming back, an identity provider) keeps being answered on the old address until it's pointed at the new one.
 * With the setting empty, nothing moves.
 */
export function proxy(request: NextRequest) {
  const to = moveTo(request);
  const response = to ? NextResponse.redirect(to, 308) : NextResponse.next();
  // Every page's content policy, read on each request (frames-origin.ts): a dashboard's frame sets its own.
  if (!new URL(request.url).pathname.startsWith("/app-frame/")) {
    response.headers.set("Content-Security-Policy", pagePolicy(process.env));
  }
  return response;
}

/** Where a request on an old address goes, or null when it stays (not an old address, not a page load, no target). */
export function moveTo(request: Request, env: Record<string, string | undefined> = process.env): URL | null {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const old = new Set(
    (env.OPENDASH_OLD_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
  if (!old.size) return null;
  let target: URL;
  try {
    target = new URL(env.BETTER_AUTH_URL ?? "");
  } catch {
    return null;
  }
  const url = new URL(request.url);
  // Behind a proxy (Railway), the address the browser asked for.
  const host = (request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? url.host)
    .split(",")[0]
    ?.trim()
    .toLowerCase()
    .replace(/:\d+$/, "");
  if (!host || !old.has(host) || host === target.hostname) return null;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/_next/")) return null;
  // The path set on the app's own origin, never resolved against it: a path of `//elsewhere/x` stays a path here.
  const to = new URL(target.origin);
  to.pathname = url.pathname;
  to.search = url.search;
  return to.origin === target.origin ? to : null;
}

export const config = { matcher: ["/((?!api/|_next/).*)"] };

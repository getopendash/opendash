import { analyticsAssetsHost, analyticsConfig, BUDGETS } from "@opendash/core";

export const dynamic = "force-dynamic";

/**
 * The browser's product analytics, relayed to PostHog from this server's own address (components/shell/analytics.tsx
 * sends to /ingest), so a content blocker doesn't drop it and the browser never talks to a third party itself. Only
 * where POSTHOG_KEY is set; elsewhere it isn't there (404).
 *
 * What's passed on is the body and the two headers that describe it. Cookies, the session and the person's address
 * aren't: PostHog sees this server, not them. PostHog's scripts (`/ingest/static/…`) come from its assets host.
 */
async function relay(request: Request, params: Promise<{ path: string[] }>): Promise<Response> {
  const config = analyticsConfig();
  if (!config) return new Response(null, { status: 404 });
  const { path } = await params;
  // Each part as PostHog names its endpoints and files: nothing that could climb out of its host.
  if (!path.length || path.some((p) => !/^[\w.-]+$/.test(p) || p === "." || p === "..")) {
    return new Response(null, { status: 404 });
  }
  const host = path[0] === "static" ? analyticsAssetsHost(config.host) : config.host;
  const target = `${host}/${path.join("/")}${new URL(request.url).search}`;

  let body: ArrayBuffer | undefined;
  if (request.method === "POST") {
    const read = await capped(request, BUDGETS.analytics.relayBytes);
    if (!read) return new Response(null, { status: 413 });
    body = read;
  }
  const headers = new Headers();
  for (const name of ["content-type", "content-encoding"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  try {
    const upstream = await fetch(target, {
      method: request.method,
      headers,
      body,
      signal: AbortSignal.timeout(BUDGETS.analytics.relayMs),
    });
    // fetch has already decoded the body, so its encoding and length don't travel with it.
    const out = new Headers();
    for (const name of ["content-type", "cache-control"]) {
      const value = upstream.headers.get(name);
      if (value) out.set(name, value);
    }
    return new Response(upstream.body, { status: upstream.status, headers: out });
  } catch {
    return new Response(null, { status: 502 });
  }
}

/** The request's body, or null past `limit` bytes: read as it arrives, so a large one is refused without being held. */
async function capped(request: Request, limit: number): Promise<ArrayBuffer | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > limit) return null;
  if (!request.body) return new ArrayBuffer(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return all.buffer;
}

type Context = { params: Promise<{ path: string[] }> };

export const GET = (request: Request, { params }: Context) => relay(request, params);
export const POST = (request: Request, { params }: Context) => relay(request, params);

/**
 * Where dashboards' frames are served from: another origin than OpenDash's own, so a dashboard's code never runs where
 * OpenDash's session does. OPENDASH_FRAMES_URL in production (a host of its own, such as frames.example.com, pointed at
 * this server). In development it's the same server under the other loopback name: http://127.0.0.1:3000 for
 * http://localhost:3000 (and the other way round), which browsers treat as another site. Null when neither applies:
 * frames don't open. Read on each request, so a built image works wherever it's deployed. Pure, for the proxy too.
 */
export function framesOriginOf(env: Record<string, string | undefined>): string | null {
  const given = env.OPENDASH_FRAMES_URL?.trim();
  try {
    if (given) return new URL(given).origin;
    if (env.NODE_ENV === "production") return null;
    const url = new URL(env.BETTER_AUTH_URL ?? "http://localhost:3000");
    if (url.hostname === "localhost") url.hostname = "127.0.0.1";
    else if (url.hostname === "127.0.0.1") url.hostname = "localhost";
    else return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * The content policy of every page but a dashboard's frame: never framed by another site, and framing only the frames
 * origin, so a dashboard's frame can't navigate itself to another site. Every page sends it, not only a dashboard's:
 * moving between pages in the app keeps the first page's policy.
 */
export const pagePolicy = (env: Record<string, string | undefined>): string =>
  `frame-ancestors 'none'; frame-src ${framesOriginOf(env) ?? "'none'"}`;

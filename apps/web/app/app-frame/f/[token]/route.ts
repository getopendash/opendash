import { frameDocument } from "@opendash/apps/frame";
import { RUNTIME_HASH } from "@opendash/apps/runtime-bundle";
import { dashboards } from "@opendash/core";
import { framesOrigin, onFramesOrigin } from "@/lib/frames";
import { webOrigin } from "@/lib/slack";

export const dynamic = "force-dynamic";

const refused = (status: number) =>
  new Response(status === 404 ? "Not found" : "This link has expired. Open the dashboard again.", {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });

/**
 * A dashboard's frame document, on the frames origin only: the link its page signed (the bundle's hash and its title,
 * until it expires), never a session. The document loads the runtime and the bundle by hash, and its policy
 * leaves it no network and lets only OpenDash's own page show it.
 */
export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  if (!onFramesOrigin(request)) return refused(404);
  const { token } = await params;
  const secret = process.env.BETTER_AUTH_SECRET;
  const origin = framesOrigin();
  const host = webOrigin();
  if (!secret || !origin || !host) return refused(404);
  const claims = dashboards.readFrameToken(secret, token);
  if (!claims) return refused(410);
  const { html, headers } = frameDocument({
    framesOrigin: origin,
    hostOrigin: host,
    runtimeHash: RUNTIME_HASH,
    bundleHash: claims.h || null,
    title: claims.t,
  });
  return new Response(html, { status: 200, headers });
}

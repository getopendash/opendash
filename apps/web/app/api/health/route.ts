import { tickIsLate } from "@opendash/core";
import { lastTick } from "@opendash/db";
import { queue } from "@/lib/sources";

export const dynamic = "force-dynamic";

/**
 * The host's health check: the app database, the queue, and whether the dispatcher ran in the
 * last 3 minutes. The web app is healthy with its database and queue (503 otherwise), so a worker that's slow to
 * start or down doesn't fail the web's deploy; the dispatcher is in the body, and `?strict=1` makes it count too, for
 * a monitor that pages on it. Unauthenticated, so it says only ok or not per check.
 */
export async function GET(request: Request) {
  const checks = { database: false, queue: false, dispatcher: false };
  try {
    const at = await lastTick();
    checks.database = true;
    checks.dispatcher = !tickIsLate(at);
  } catch {
    // The database can't be reached: the dispatcher can't be read either.
  }
  try {
    checks.queue = await (await queue()).isInstalled();
  } catch {
    // The queue can't be reached.
  }
  const strict = new URL(request.url).searchParams.get("strict") === "1";
  const ok = checks.database && checks.queue && (!strict || checks.dispatcher);
  return Response.json({ ok, checks }, { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } });
}

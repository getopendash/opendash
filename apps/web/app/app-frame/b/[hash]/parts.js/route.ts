import { sql, withPublic } from "@opendash/db";
import { scriptResponse } from "@/lib/frame-script";
import { onFramesOrigin } from "@/lib/frames";

export const dynamic = "force-dynamic";

/**
 * A dashboard's parts bundle by its hash, on the frames origin only, which has no session: read through
 * app.dashboard_bundle, which answers for a version or a draft of a dashboard that isn't deleted and nothing else. A
 * bundle is the parts' code, never their data.
 */
export async function GET(request: Request, { params }: { params: Promise<{ hash: string }> }) {
  const { hash } = await params;
  if (!onFramesOrigin(request) || !/^[0-9a-f]{64}$/.test(hash)) return new Response("Not found", { status: 404 });
  const [row] = await withPublic((tx) =>
    tx.execute<{ bundle: string | null }>(sql`select app.dashboard_bundle(${hash}) as bundle`),
  );
  if (!row?.bundle) return new Response("Not found", { status: 404 });
  return scriptResponse(request, hash, row.bundle);
}

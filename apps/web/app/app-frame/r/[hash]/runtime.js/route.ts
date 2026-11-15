import { RUNTIME_HASH, RUNTIME_JS } from "@opendash/apps/runtime-bundle";
import { scriptResponse } from "@/lib/frame-script";
import { onFramesOrigin } from "@/lib/frames";

export const dynamic = "force-dynamic";

/** The runtime every dashboard's frame loads, by its hash (immutable), on the frames origin only, compressed. */
export async function GET(request: Request, { params }: { params: Promise<{ hash: string }> }) {
  const { hash } = await params;
  if (!onFramesOrigin(request) || hash !== RUNTIME_HASH) return new Response("Not found", { status: 404 });
  return scriptResponse(request, hash, RUNTIME_JS);
}

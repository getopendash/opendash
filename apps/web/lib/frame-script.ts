import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";
import { scriptHeaders } from "@opendash/apps/frame";

/**
 * A frame's script (the runtime, an App's bundle) on its way out, compressed as the request accepts it. These route
 * responses left production as they are (the runtime's 1.09 MB was sent whole), and a frame's sandbox
 * has no origin, so the browser keeps nothing between opens: every open pays for every byte. Each script is compressed
 * once (by its hash, which names its contents) and kept among the last few asked for: the runtime, asked for by every
 * open, is always one of them.
 */
export type ScriptEncoding = "br" | "gzip";

const brotli = promisify(brotliCompress);
const gz = promisify(gzip);

/** Below this a script goes as it is: compressing it saves less than its headers cost. */
const SMALLEST = 1024;
/** Scripts kept compressed: the runtime and the bundles of the Apps open lately, in each encoding. */
const KEPT = 64;
const kept = new Map<string, Promise<Buffer>>();

/**
 * The encoding to answer with: Brotli when the request takes it, gzip otherwise, neither when it takes neither (or
 * refuses them with `q=0`).
 */
export function acceptedEncoding(header: string | null): ScriptEncoding | null {
  const takes = new Set<string>();
  const refuses = new Set<string>();
  for (const part of (header ?? "").split(",")) {
    const [name = "", ...params] = part.split(";").map((s) => s.trim().toLowerCase());
    if (!name) continue;
    const q = params.find((p) => p.startsWith("q="));
    (!q || Number(q.slice(2)) > 0 ? takes : refuses).add(name);
  }
  // A wildcard takes whatever isn't refused by name.
  const ok = (name: ScriptEncoding) => takes.has(name) || (takes.has("*") && !refuses.has(name));
  return ok("br") ? "br" : ok("gzip") ? "gzip" : null;
}

function compressed(hash: string, encoding: ScriptEncoding, body: string): Promise<Buffer> {
  const key = `${encoding}:${hash}`;
  const had = kept.get(key);
  if (had) {
    // Asked for again: the last to be let go of.
    kept.delete(key);
    kept.set(key, had);
    return had;
  }
  const bytes = Buffer.from(body);
  const made = (
    encoding === "br"
      ? // Quality 9: within a few percent of the smallest, in tens of milliseconds for the runtime (11 takes a second).
        brotli(bytes, {
          params: { [constants.BROTLI_PARAM_QUALITY]: 9, [constants.BROTLI_PARAM_SIZE_HINT]: bytes.byteLength },
        })
      : gz(bytes, { level: 9 })
  ).catch((error: unknown) => {
    kept.delete(key);
    throw error;
  });
  kept.set(key, made);
  for (const oldest of kept.keys()) {
    if (kept.size <= KEPT) break;
    kept.delete(oldest);
  }
  return made;
}

/** A script's response: immutable by its hash, compressed as the request accepts, the same script either way. */
export async function scriptResponse(request: Request, hash: string, body: string): Promise<Response> {
  const headers = { ...scriptHeaders, vary: "Accept-Encoding" };
  const encoding = body.length >= SMALLEST ? acceptedEncoding(request.headers.get("accept-encoding")) : null;
  if (!encoding) return new Response(body, { status: 200, headers });
  const bytes = await compressed(hash, encoding, body);
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { ...headers, "content-encoding": encoding, "content-length": String(bytes.byteLength) },
  });
}

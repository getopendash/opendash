import { getAuth } from "@/lib/auth";

/**
 * Auth requests carry small bodies: a sign-in, a SAML assertion, a directory's user or group. Anything past 1 MiB is
 * refused before Better Auth reads it (a directory plugin reads its whole body to normalize it), whether or not the
 * client said how long it was.
 */
const MAX_BODY_BYTES = 1024 * 1024;

const tooLarge = () => new Response(null, { status: 413 });

async function bounded(request: Request): Promise<Request | Response> {
  if (!request.body) return request;
  const declared = Number(request.headers.get("content-length") ?? "");
  if (declared > MAX_BODY_BYTES) return tooLarge();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return tooLarge();
    }
    chunks.push(value);
  }
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: Buffer.concat(chunks),
    signal: request.signal,
  });
}

/** GET and POST for sign-in; PUT, PATCH and DELETE for directory sync (SCIM 2.0). */
async function handle(request: Request): Promise<Response> {
  const body = await bounded(request);
  return body instanceof Response ? body : getAuth().handler(body);
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;

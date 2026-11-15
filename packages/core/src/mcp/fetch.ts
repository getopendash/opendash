/**
 * The only way OpenDash reaches an MCP server or its authorization server: discovery, registration,
 * token, refresh and the server itself all go through it, handed to the official client as its `fetch`.
 *   - Only addresses the deployment's edition allows: cloud refuses private ranges and loopback, every edition refuses
 *     link-local (cloud metadata) and reserved ones (`vetHost`, as sources do).
 *   - The host is resolved once per request and the connection made to a vetted address, so DNS can't change between
 *     the check and the request.
 *   - https in cloud; a self-hosted install may use http, as it may reach internal servers.
 *   - A redirect is followed only when asked, each hop vetted again, at most BUDGETS.mcp.redirects, never from https
 *     to http, and only a few plain headers (never Authorization, a cookie or an API key's) go on when it leaves the
 *     origin. `redirect: "manual"` gets the 3xx back as it is (the client's transport follows within its origin
 *     itself, through this fetch again).
 *   - Each request is over by BUDGETS.mcp.requestMs and its body is cut off past BUDGETS.mcp.responseBytes.
 */
import http from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { type Edition, NetworkRefused, vetHost } from "@opendash/connectors/network";
import { BUDGETS } from "../budgets";

export type McpFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** A request the guard refused or couldn't finish. `refused`: it never left, because of where it was going. */
export class McpNetworkError extends Error {
  override name = "McpNetworkError";
  constructor(
    message: string,
    readonly refused = false,
  ) {
    super(message);
  }
}

export interface GuardOptions {
  edition: Edition;
  requestMs?: number;
  lookupMs?: number;
  redirects?: number;
  responseBytes?: number;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const NULL_BODY = new Set([101, 204, 205, 304]);
/**
 * The only headers sent on when a redirect leaves the origin. Everything else stays behind: Authorization, cookies,
 * and any header a server named for its API key (X-API-Key and the like), which the guard can't tell from others.
 */
const CROSS_ORIGIN_SAFE = new Set(["accept", "accept-language", "content-type", "mcp-protocol-version", "user-agent"]);

function headersOf(...sources: (ConstructorParameters<typeof Headers>[0] | undefined)[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const source of sources) {
    if (!source) continue;
    new Headers(source).forEach((value, key) => {
      out[key] = value;
    });
  }
  return out;
}

async function bodyOf(
  body: RequestInit["body"] | ArrayBuffer | undefined,
  headers: Record<string, string>,
): Promise<Buffer | undefined> {
  if (body == null) return undefined;
  if (typeof body === "string") {
    headers["content-type"] ??= "text/plain;charset=UTF-8";
    return Buffer.from(body, "utf8");
  }
  if (body instanceof URLSearchParams) {
    headers["content-type"] ??= "application/x-www-form-urlencoded;charset=UTF-8";
    return Buffer.from(body.toString(), "utf8");
  }
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof Blob) return Buffer.from(await body.arrayBuffer());
  throw new McpNetworkError("OpenDash can't send that kind of request body");
}

/** The vetted addresses for a URL this edition may reach, or a refusal saying why not. */
async function vet(url: URL, options: Required<GuardOptions>): Promise<string[]> {
  if (url.username || url.password)
    throw new McpNetworkError(`${url.host} mustn't carry a user name or password`, true);
  const httpAllowed = options.edition === "community";
  if (url.protocol !== "https:" && !(httpAllowed && url.protocol === "http:")) {
    throw new McpNetworkError(
      httpAllowed ? `${url.href} isn't an http(s) address` : `${url.host} must use https`,
      true,
    );
  }
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      vetHost(host, options.edition),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new McpNetworkError(`${host} didn't resolve in time`)), options.lookupMs);
      }),
    ]);
  } catch (error) {
    if (error instanceof McpNetworkError) throw error;
    if (error instanceof NetworkRefused) throw new McpNetworkError(error.message, true);
    throw new McpNetworkError(`${host} didn't resolve`);
  } finally {
    clearTimeout(timer);
  }
}

/** One request to one vetted host, its response a web Response whose body stops at `maxBytes`. */
function once(
  url: URL,
  addresses: string[],
  request: { method: string; headers: Record<string, string>; body?: Buffer; signal: AbortSignal; maxBytes: number },
): Promise<Response> {
  const pinned: LookupFunction = (_host, opts, done) => {
    const list = addresses.map((address) => ({ address, family: isIP(address) }));
    if (opts.all) (done as (e: Error | null, a: { address: string; family: number }[]) => void)(null, list);
    else done(null, list[0]?.address ?? "", list[0]?.family ?? 4);
  };
  const headers = { ...request.headers };
  if (request.body) headers["content-length"] = String(request.body.length);
  else delete headers["content-length"];
  return new Promise<Response>((resolve, reject) => {
    const req = (url.protocol === "http:" ? http : https).request(
      url,
      { method: request.method, headers, signal: request.signal, lookup: pinned, agent: false },
      (res) => {
        const status = res.statusCode ?? 0;
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (value === undefined) continue;
          for (const v of Array.isArray(value) ? value : [value]) responseHeaders.append(key, v);
        }
        if (status < 200 || status > 599) {
          res.resume();
          reject(new McpNetworkError(`${url.host} answered ${status}`));
          return;
        }
        if (NULL_BODY.has(status) || request.method === "HEAD") {
          res.resume();
          resolve(new Response(null, { status, statusText: res.statusMessage, headers: responseHeaders }));
          return;
        }
        let size = 0;
        let settled = false;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            const fail = (error: Error) => {
              if (settled) return;
              settled = true;
              controller.error(error);
            };
            res.on("data", (chunk: Buffer) => {
              if (settled) return;
              size += chunk.length;
              if (size > request.maxBytes) {
                fail(new McpNetworkError(`${url.host} sent more than its size limit`));
                res.destroy();
                return;
              }
              controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
            });
            res.on("end", () => {
              if (settled) return;
              settled = true;
              controller.close();
            });
            res.on("error", (error) =>
              fail(request.signal.aborted ? new McpNetworkError(`${url.host} didn't answer in time`) : error),
            );
            res.on("aborted", () => fail(new McpNetworkError(`${url.host} stopped answering`)));
          },
          cancel() {
            settled = true;
            res.destroy();
          },
        });
        resolve(new Response(body, { status, statusText: res.statusMessage, headers: responseHeaders }));
      },
    );
    req.on("error", (error) =>
      reject(request.signal.aborted ? new McpNetworkError(`${url.host} didn't answer in time`) : error),
    );
    req.end(request.body);
  });
}

/** A fetch for MCP that reaches only what this edition allows. */
export function guardedFetch(options: GuardOptions): McpFetch {
  const settings: Required<GuardOptions> = {
    edition: options.edition,
    requestMs: options.requestMs ?? BUDGETS.mcp.requestMs,
    lookupMs: options.lookupMs ?? BUDGETS.mcp.lookupMs,
    redirects: options.redirects ?? BUDGETS.mcp.redirects,
    responseBytes: options.responseBytes ?? BUDGETS.mcp.responseBytes,
  };
  return async (input, init) => {
    const fromRequest = input instanceof Request ? input : undefined;
    let url = new URL(fromRequest ? fromRequest.url : String(input));
    let method = (init?.method ?? fromRequest?.method ?? "GET").toUpperCase();
    const headers = headersOf(fromRequest?.headers, init?.headers);
    const rawBody =
      init?.body ??
      (fromRequest && method !== "GET" && method !== "HEAD" ? await fromRequest.arrayBuffer() : undefined);
    let body = await bodyOf(rawBody, headers);
    const mode = init?.redirect ?? fromRequest?.redirect ?? "follow";
    const timeout = AbortSignal.timeout(settings.requestMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;

    for (let hop = 0; ; hop++) {
      const addresses = await vet(url, settings);
      const response = await once(url, addresses, { method, headers, body, signal, maxBytes: settings.responseBytes });
      const location = REDIRECTS.has(response.status) ? response.headers.get("location") : null;
      if (!location || mode === "manual") return response;
      await response.body?.cancel().catch(() => {});
      if (mode === "error") throw new McpNetworkError(`${url.host} redirected, and this request doesn't follow`);
      if (hop >= settings.redirects) throw new McpNetworkError(`${url.host} redirected too many times`);
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        throw new McpNetworkError(`${url.host} redirected to something that isn't an address`);
      }
      if (url.protocol === "https:" && next.protocol !== "https:") {
        throw new McpNetworkError(`${url.host} redirected from https to ${next.protocol}`, true);
      }
      if (next.origin !== url.origin) {
        for (const name of Object.keys(headers)) if (!CROSS_ORIGIN_SAFE.has(name)) delete headers[name];
      }
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
        method = "GET";
        body = undefined;
        delete headers["content-type"];
      }
      url = next;
    }
  };
}

/** Checks a server's address as an admin gives it: an address this edition may reach, resolved now. */
export async function checkAddress(value: string, edition: Edition): Promise<URL> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new McpNetworkError("That isn't a web address", true);
  }
  if (url.hash) throw new McpNetworkError("The address mustn't have a #fragment", true);
  await vet(url, {
    edition,
    requestMs: BUDGETS.mcp.requestMs,
    lookupMs: BUDGETS.mcp.lookupMs,
    redirects: BUDGETS.mcp.redirects,
    responseBytes: BUDGETS.mcp.responseBytes,
  });
  return url;
}

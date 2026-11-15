/** The router over HTTP (the RPC protocol the client speaks), for a Next.js route handler to mount. */
import { randomUUID } from "node:crypto";
import { loggableError, loggableStack } from "@opendash/core";
import { COMMON_ERROR_STATUS_MAP, onError } from "@orpc/server";
import { BodyLimitPlugin, RPCHandler } from "@orpc/server/fetch";
import { ERROR_STATUS_MAP } from "./contract";
import { type ApiContext, type ApiDeps, createRouter } from "./router";

/**
 * oRPC's own codes (a body it can't read is BAD_REQUEST, an unknown path NOT_FOUND) keep their statuses beside the
 * contract's: a map given to oRPC replaces its own, and a code missing from it answers 500.
 */
const STATUSES: Record<string, number> = { ...COMMON_ERROR_STATUS_MAP, ...ERROR_STATUS_MAP };

/** The largest request body read, before who's asking is known: the API's own inputs are far smaller. */
/**
 * The most an RPC body may be: room for a question's references (two images of 2 MB and three files' text, as
 * base64) or one file read (8 MB as base64), and no more.
 */
export const MAX_RPC_BODY_BYTES = 12 * 1024 * 1024;

/**
 * A browser's request from another site (or another origin of the same site): refused, so a page elsewhere can't
 * make a signed-in person's browser change things here (a cookie is sent with a same-site request). Browsers say
 * where a request comes from (`Sec-Fetch-Site`, else `Origin`); a client that isn't a browser (an API key) says
 * neither.
 */
export function fromElsewhere(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site) return site !== "same-origin" && site !== "none";
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}

/** The header a failed call's reference travels in: sent back on every answer, and on the log line of one that broke. */
export const REQUEST_ID_HEADER = "x-request-id";

/**
 * A call's reference: the one a proxy in front already gave it (so its logs and ours agree), when it looks like
 * one, else one made here. Never trusted as more than a label: it's only written to a log line and sent back.
 */
export function requestId(headers: Headers): string {
  const given = headers.get(REQUEST_ID_HEADER) ?? headers.get("x-railway-request-id");
  return given && /^[A-Za-z0-9._:-]{8,128}$/.test(given) ? given : randomUUID();
}

export function createRpcHandler(deps: ApiDeps, options: { prefix: `/${string}` }) {
  const handler = new RPCHandler(createRouter(deps), {
    // A larger body is refused (413) as it arrives, before it's read whole or anyone is resolved.
    plugins: [new BodyLimitPlugin({ maxBodySize: MAX_RPC_BODY_BYTES })],
    errorStatusMap: STATUSES,
    // Around each procedure's call, once its input is read: a body that can't be read never reaches it (oRPC answers it
    // 400, by the map). Errors the contract defines are answers, and so is input the client got wrong (a 4xx): anything
    // else is a bug worth a log line. What it says: which procedure, for whom, the call's reference, and where it was
    // thrown; never the input, and never a failed query's SQL or parameters (a database error's message carries a
    // source's values: `loggableError` keeps the database's own words and code only).
    clientInterceptors: [
      onError((error, call) => {
        const e = error as { defined?: boolean; name?: string; code?: string };
        const status = (e.code && STATUSES[e.code]) || 500;
        if (e.defined || status < 500) return;
        const { path, context } = call;
        console.error(
          JSON.stringify({
            level: "error",
            msg: "api error",
            procedure: path?.join(".") ?? null,
            requestId: context?.requestId ?? null,
            orgId: context?.seen?.orgId ?? null,
            userId: context?.seen?.userId ?? null,
            name: e.name,
            error: loggableError(error),
            stack: loggableStack(error),
          }),
        );
      }),
    ],
  });
  return async (request: Request): Promise<Response> => {
    if (fromElsewhere(request)) return new Response("Forbidden", { status: 403 });
    const id = requestId(request.headers);
    const context: ApiContext = { headers: request.headers, requestId: id, seen: {} };
    const { response } = await handler.handle(request, { prefix: options.prefix, context });
    const answer = response ?? new Response("Not found", { status: 404 });
    // The reference someone can quote: it finds the log line of a call that broke.
    answer.headers.set(REQUEST_ID_HEADER, id);
    return answer;
  };
}

/**
 * What a failed model call means, read from the error alone, so the run does the right thing with it:
 * - busy: the provider is overloaded, rate limited or unreachable; the job retries later, from the saved transcript;
 * - stalled: the call's stream went quiet (model.ts); a retry may get through;
 * - too_long: the prompt is longer than the model takes; folding the transcript harder, then retrying once, may fit;
 * - key: the provider refused the key, or its access to this model; retrying can't help;
 * - billing: the account is out of credit or over quota; retrying can't help, and it's never "busy";
 * - bad_request: the provider won't take this request (a 400 that isn't length, a model gone); retrying can't help.
 * Patterns follow pi-ai's `utils/retry.ts` and `utils/overflow.ts` (MIT, see licenses/pi-ai.txt), and the error texts
 * the providers send. The error's text is read here only: nothing it says is logged or rethrown.
 */
import { ModelStalled } from "./model";

export type ModelErrorKind = "busy" | "stalled" | "too_long" | "key" | "billing" | "bad_request";

export interface ModelErrorReading {
  kind: ModelErrorKind;
  status?: number;
}

const TOO_LONG =
  /prompt is too long|context[_ ]length[_ ]exceeded|maximum context length|context window|too many (input )?tokens|input is too long|request too large|exceeds the (model'?s )?(maximum|context)|reduce the length/i;
/** A 429 is a quota only when the provider says so in these words (OpenAI's insufficient_quota); else it's a rate limit. */
const QUOTA = /insufficient[_ ]quota|exceeded your current quota/i;
const BILLING =
  /insufficient[_ ]quota|billing|credit balance|exceeded your current quota|payment required|out of credits|spending limit/i;
const KEY = /invalid[_ ]?api[_ ]?key|invalid x-api-key|authentication|unauthori[sz]ed|permission[_ ]denied/i;

interface ErrorLike {
  name?: string;
  message?: string;
  statusCode?: number;
  responseBody?: string;
  cause?: unknown;
  lastError?: unknown;
}

/** The error and what it wraps: the SDK's RetryError keeps the last attempt's error, a fetch error keeps its cause. */
function chain(error: unknown): ErrorLike[] {
  const out: ErrorLike[] = [];
  let e: unknown = error;
  for (let depth = 0; e && typeof e === "object" && depth < 5; depth += 1) {
    const x = e as ErrorLike;
    out.push(x);
    e = x.lastError ?? x.cause;
  }
  return out;
}

export function readModelError(error: unknown): ModelErrorReading {
  const links = chain(error);
  if (links.some((e) => e instanceof ModelStalled || e.name === "ModelStalled")) return { kind: "stalled" };
  const status = links.find((e) => typeof e.statusCode === "number")?.statusCode;
  const text = links
    .map((e) => `${e.message ?? ""} ${typeof e.responseBody === "string" ? e.responseBody : ""}`)
    .join(" ");
  const at = (kind: ModelErrorKind): ModelErrorReading => (status === undefined ? { kind } : { kind, status });
  if (status === 413 || TOO_LONG.test(text)) return at("too_long");
  if (status === 429) return at(QUOTA.test(text) ? "billing" : "busy");
  if (status === 402 || BILLING.test(text)) return at("billing");
  if (status === 401 || status === 403 || (status === undefined && KEY.test(text))) return at("key");
  if (status !== undefined && [408, 409, 425, 429].includes(status)) return at("busy");
  if (status !== undefined && status >= 500) return at("busy");
  if (status !== undefined && status >= 400) return at("bad_request");
  // No status: a network failure, or anything unknown, is retried as a busy provider is.
  return at("busy");
}

/** What the person is told when retrying can't help, by kind. */
export const MODEL_REFUSED: Record<"key" | "billing" | "bad_request" | "too_long", string> = {
  // A 403 is often the key's access to this model, not the key (a gateway's free tier, Bedrock or Vertex model access).
  key: "The model provider refused the key or its access to this model. An owner or admin can check it in Settings → AI.",
  billing:
    "The model provider says the account is out of credit or over its quota. An owner or admin can check it with the provider.",
  bad_request: "The model couldn't take this request. Ask again; if it keeps happening, try another model.",
  too_long: "This conversation has grown too long for the model. Start a new conversation to go on.",
};

/** The same, for a run nobody is waiting on (its work is one long turn, not a conversation). */
export const WORK_TOO_LONG = "Its work grew too long for the model to take in one request.";

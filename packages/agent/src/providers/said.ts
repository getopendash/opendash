/**
 * What a provider said when it turned a call down, in its own words, for a provider's test (check.ts). Its error body
 * is read in the shapes the providers use: `{error: {message}}` (OpenAI, Google, OpenRouter, Vercel AI Gateway),
 * Anthropic's `{type: "error", error: {message}}`, `{error: "…"}`, and AWS's `{message}` or `{Message}`. An HTML page
 * (a proxy's) isn't words. Before anything is stored or shown, the credentials tested are taken out, and so is anything
 * shaped like a key, since some providers echo part of one back; a link stays, being often the thing to do.
 */

const MAX = 300;

/** Key shapes a provider might echo: OpenAI's, the gateway's, AWS access key ids, Google API keys, bearer tokens. */
const KEYS = [
  /\bsk-[A-Za-z0-9_*-]{8,}/g,
  /\bvck_[A-Za-z0-9]{8,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
];

/** The text without the credentials tested, or anything shaped like a key, in one line and not too long. */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) if (s.trim().length >= 6) out = out.split(s.trim()).join("…");
  for (const key of KEYS) out = out.replace(key, "…");
  out = out.replace(/\s+/g, " ").trim();
  return out.length > MAX ? `${out.slice(0, MAX - 1).trimEnd()}…` : out;
}

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** The words in an error body, parsed or not; null when it has none (empty, or an HTML page). */
export function wordsIn(body: unknown): string | null {
  if (typeof body === "string") {
    const raw = body.trim();
    if (!raw || raw.startsWith("<")) return null;
    try {
      return wordsIn(JSON.parse(raw));
    } catch {
      return raw;
    }
  }
  if (!body || typeof body !== "object") return null;
  const o = body as Record<string, unknown>;
  const error = o.error;
  if (error && typeof error === "object") {
    const inner = text((error as Record<string, unknown>).message);
    if (inner) return inner;
  }
  const errors = Array.isArray(o.errors) ? (o.errors[0] as Record<string, unknown> | undefined) : undefined;
  return text(error) ?? text(o.message) ?? text(o.Message) ?? text(o.detail) ?? text(errors?.message) ?? null;
}

/** What a failed call came to: the status it answered with, if it answered, and its words, if it gave any. */
export interface Said {
  status?: number;
  words: string | null;
  /** It never answered: why, as far as the error says ("no answer within 30 s", "ENOTFOUND"). */
  unreached?: string;
}

interface ErrorLike {
  name?: string;
  message?: string;
  statusCode?: number;
  responseBody?: unknown;
  code?: unknown;
  cause?: unknown;
  lastError?: unknown;
}

/** The error and what it wraps: the gateway's errors keep the SDK's call error, a fetch error keeps its cause. */
function chain(error: unknown): ErrorLike[] {
  const out: ErrorLike[] = [];
  let e: unknown = error;
  for (let depth = 0; e && typeof e === "object" && depth < 5; depth += 1) {
    out.push(e as ErrorLike);
    e = (e as ErrorLike).lastError ?? (e as ErrorLike).cause;
  }
  return out;
}

const CODES: Record<string, string> = {
  ENOTFOUND: "its address didn't resolve (ENOTFOUND)",
  ECONNREFUSED: "the connection was refused (ECONNREFUSED)",
  ECONNRESET: "the connection was reset (ECONNRESET)",
  UND_ERR_CONNECT_TIMEOUT: "the connection timed out",
};

/** What a call's error says: the provider's body first, then the SDK's message for it; or why nothing answered. */
export function readFailure(error: unknown, secrets: readonly string[], waitedMs: number): Said {
  const links = chain(error);
  const status = links.find((e) => typeof e.statusCode === "number")?.statusCode;
  if (status === undefined) {
    if (links.some((e) => e.name === "TimeoutError" || e.name === "AbortError")) {
      return { words: null, unreached: `no answer within ${Math.round(waitedMs / 1000)} s` };
    }
    const code = links.map((e) => e.code).find((c): c is string => typeof c === "string");
    const why = code ? (CODES[code] ?? code) : text(links.at(-1)?.message);
    return { words: null, unreached: why ? redact(why, secrets) : "no answer" };
  }
  const said =
    links.map((e) => wordsIn(e.responseBody)).find((w) => w !== null) ??
    links.map((e) => (typeof e.statusCode === "number" ? text(e.message) : null)).find((w) => w !== null) ??
    null;
  return { status, words: said ? redact(said, secrets) : null };
}

/** A failure for a person: the provider's words with its status, or ours only when it gave none. */
export function toldBy(label: string, said: Said): string {
  if (said.status === undefined) return `Couldn't reach ${label}: ${said.unreached ?? "no answer"}.`;
  if (said.words) return `${label} said (${said.status}): ${said.words}${/[.!?…]$/.test(said.words) ? "" : "."}`;
  if (said.status === 401) return `${label} refused these credentials (401) without saying why.`;
  if (said.status === 402) return `${label} says the account has no credit left (402).`;
  return `${label} answered ${said.status} without saying why.`;
}

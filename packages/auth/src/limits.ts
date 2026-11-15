/**
 * Rate limits for the auth endpoints, counted in Postgres so they hold across restarts and replicas.
 *
 *   - Per IP: Better Auth's own limits, with this module as their store. Requests whose IP can't be trusted share
 *     one strict bucket per path (fail closed). With a proxy configured correctly that bucket only ever holds
 *     traffic that forged its headers.
 *   - Per account, whatever the IP, in two levels:
 *       per account and IP: strict, so guessing from one place stops without locking the owner out elsewhere;
 *       per account overall: higher, the backstop when IPs rotate. Password sign-in then pauses, and the owner can
 *       still get in with an email link, which an attacker can't use without the inbox.
 *     Every attempt is counted before it runs, in one atomic statement, so a burst of parallel requests can't slip
 *     past the limit. A successful sign-in clears that account's sign-in counters.
 */
import { createHash } from "node:crypto";
import { uuidv7 } from "@opendash/db";
import type { AuthDatabase } from "@opendash/db/auth";
import { sql } from "drizzle-orm";

export interface LimitRule {
  /** Seconds. */
  window: number;
  max: number;
}

export interface LimitDecision {
  allowed: boolean;
  /** Seconds until the window resets, when refused. */
  retryAfter: number | null;
}

const MINUTES = 60;
const HOUR = 60 * MINUTES;

export const ACCOUNT_LIMITS = {
  signInPerIp: { window: 15 * MINUTES, max: 10 },
  signIn: { window: 15 * MINUTES, max: 50 },
  emailLinksPerIp: { window: HOUR, max: 6 },
  emailLinks: { window: HOUR, max: 30 },
  passwordResetsPerIp: { window: HOUR, max: 3 },
  passwordResets: { window: HOUR, max: 10 },
} satisfies Record<string, LimitRule>;

export type AccountLimit = keyof typeof ACCOUNT_LIMITS;

/** Which limits each endpoint consumes: the per-IP level first, then the account-wide one. */
export const ENDPOINT_LIMITS: Record<string, [perIp: AccountLimit, overall: AccountLimit]> = {
  "/sign-in/email": ["signInPerIp", "signIn"],
  "/sign-in/magic-link": ["emailLinksPerIp", "emailLinks"],
  "/request-password-reset": ["passwordResetsPerIp", "passwordResets"],
};

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/** Counter keys hash the address (and IP), so auth.rate_limit holds no personal data in the clear. */
export const accountKey = (limit: AccountLimit, email: string, ip?: string | null) =>
  `acct:${limit}:${hash(email.trim().toLowerCase())}${ip === undefined ? "" : `:${hash(ip ?? "unknown")}`}`;

const decide = (count: number, windowStart: number, rule: LimitRule, now: number): LimitDecision =>
  count <= rule.max
    ? { allowed: true, retryAfter: null }
    : { allowed: false, retryAfter: Math.max(1, Math.ceil((windowStart + rule.window * 1000 - now) / 1000)) };

/** Fixed-window counters in auth.rate_limit. `consume` counts and decides in one statement. */
export function postgresLimiter(database: AuthDatabase) {
  async function consume(key: string, rule: LimitRule): Promise<LimitDecision> {
    const now = Date.now();
    const expired = now - rule.window * 1000;
    const rows = await database.db.execute<{ count: number; last_request: string | number }>(sql`
      insert into auth.rate_limit (id, key, count, last_request) values (${uuidv7()}, ${key}, 1, ${now})
      on conflict (key) do update set
        count = case when auth.rate_limit.last_request <= ${expired} then 1 else auth.rate_limit.count + 1 end,
        last_request = case when auth.rate_limit.last_request <= ${expired} then ${now} else auth.rate_limit.last_request end
      returning count, last_request`);
    const row = rows[0];
    return decide(Number(row?.count ?? 1), Number(row?.last_request ?? now), rule, now);
  }

  async function reset(keys: string[]): Promise<void> {
    if (keys.length) await database.db.execute(sql`delete from auth.rate_limit where key in ${keys}`);
  }

  /** Better Auth's rateLimit.customStorage: every key is counted, including its untrusted-IP bucket. */
  const betterAuthStorage = { consume: (key: string, rule: LimitRule) => consume(`ip:${key}`, rule) };

  return { consume, reset, betterAuthStorage };
}

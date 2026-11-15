/**
 * API keys end with what they act for (entry paths). A user's keys go
 * when the account is recovered (a password reset, the operator's two-factor reset), so whoever held a session can't
 * keep acting as them afterwards, and so do the organization keys that account made: each org key records its maker
 * in its metadata (`recordKeyMaker`), which nobody else writes (Better Auth's metadata is off, so clients can't). An
 * organization's keys all go when an owner stops being one (removed, demoted, or leaving): only owners make them, and
 * a key made before its maker was recorded might be the one who left. The remaining owners make new ones.
 */
import { type AuthDatabase, authTables as t } from "@opendash/db/auth";
import { and, eq, or, sql } from "drizzle-orm";

/** How long every key works: no key is made with, or given, another life. */
export const API_KEY_TTL_SECONDS = 90 * 24 * 60 * 60;

type Writer = Pick<AuthDatabase["db"], "delete">;

/** Notes who made an org key, so recovering their account ends it (`revokeUserKeys`). */
export async function recordKeyMaker(
  db: Pick<AuthDatabase["db"], "update">,
  keyId: string,
  userId: string,
): Promise<void> {
  await db
    .update(t.apikey)
    .set({ metadata: JSON.stringify({ madeBy: userId }) })
    .where(and(eq(t.apikey.id, keyId), eq(t.apikey.configId, "org")));
}

/** Every odu_ key of this user, and every odo_ key they made. */
export async function revokeUserKeys(db: Writer, userId: string): Promise<number> {
  const madeBy = sql`(case when ${t.apikey.metadata} is json object then (${t.apikey.metadata})::jsonb->>'madeBy' end)`;
  const gone = await db
    .delete(t.apikey)
    .where(
      or(
        and(eq(t.apikey.configId, "user"), eq(t.apikey.referenceId, userId)),
        and(eq(t.apikey.configId, "org"), sql`${madeBy} = ${userId}`),
      ),
    )
    .returning({ id: t.apikey.id });
  return gone.length;
}

/** Every odo_ key of this organization. */
export async function revokeOrgKeys(db: Writer, orgId: string): Promise<number> {
  const gone = await db
    .delete(t.apikey)
    .where(and(eq(t.apikey.configId, "org"), eq(t.apikey.referenceId, orgId)))
    .returning({ id: t.apikey.id });
  return gone.length;
}

/** A Better Auth role field can hold a list ("owner,admin"). */
export const isOwnerRole = (role: string | null | undefined): boolean =>
  (role ?? "")
    .split(",")
    .map((r) => r.trim())
    .includes("owner");

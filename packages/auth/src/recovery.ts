/**
 * For whoever runs the deployment: turns off a person's two-factor sign-in when they've lost both the app and their
 * backup codes. It signs them out everywhere, revokes their API
 * keys and forgets every browser they trusted, so the next sign-in is the password alone, on purpose, by them.
 */
import { type AuthDatabase, authTables as t } from "@opendash/db/auth";
import { and, eq, like, or, sql } from "drizzle-orm";
import { revokeUserKeys } from "./keys";

export type TwoFactorOff =
  | { found: false }
  | { found: true; userId: string; wasOn: boolean; sessions: number; keys: number };

export async function turnOffTwoFactor(db: AuthDatabase, email: string): Promise<TwoFactorOff> {
  return db.db.transaction(async (tx) => {
    const [user] = await tx
      .select({ id: t.user.id, on: t.user.twoFactorEnabled })
      .from(t.user)
      .where(sql`lower(${t.user.email}) = ${email.trim().toLowerCase()}`)
      .limit(1);
    if (!user) return { found: false };
    await tx.delete(t.twoFactor).where(eq(t.twoFactor.userId, user.id));
    await tx.update(t.user).set({ twoFactorEnabled: false }).where(eq(t.user.id, user.id));
    // Trusted browsers and challenges under way are verification rows holding the user's id.
    await tx
      .delete(t.verification)
      .where(
        and(
          eq(t.verification.value, user.id),
          or(like(t.verification.identifier, "trust-device-%"), like(t.verification.identifier, "2fa-%")),
        ),
      );
    // Sessions before keys: a key made with one of them meanwhile is either deleted here or, waiting on its session's
    // row (auth.ts, after "/api-key/create"), finds it gone once this commits.
    const sessions = await tx.delete(t.session).where(eq(t.session.userId, user.id)).returning({ id: t.session.id });
    const keys = await revokeUserKeys(tx, user.id);
    return { found: true, userId: user.id, wasOn: Boolean(user.on), sessions: sessions.length, keys };
  });
}

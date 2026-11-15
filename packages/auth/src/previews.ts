import { type AuthDatabase, authTables } from "@opendash/db/auth";
import { and, eq, gt, sql } from "drizzle-orm";

/** The email a password-reset link belongs to, or null if the link is unknown or expired. */
export async function resetPasswordEmail(database: AuthDatabase, token: string): Promise<string | null> {
  if (!token || token.length > 128) return null;
  const t = authTables;
  const [row] = await database.db
    .select({ email: t.user.email })
    .from(t.verification)
    .innerJoin(t.user, sql`${t.user.id}::text = ${t.verification.value}`)
    .where(and(eq(t.verification.identifier, `reset-password:${token}`), gt(t.verification.expiresAt, new Date())))
    .limit(1);
  return row?.email ?? null;
}

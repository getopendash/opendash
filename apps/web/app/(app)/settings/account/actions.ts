"use server";

import { accountDeletionPlan, confirmPassword, deleteAccount, getAuthDatabase } from "@opendash/auth";
import { loggableError } from "@opendash/core";
import { requireTenant } from "@/lib/auth";
import { erasedFromWorkspace, releaseSlack } from "@/lib/data";

export type DeleteAccountResult = { ok: true } | { ok: false; field: "email" | "password" | null; message: string };

/**
 * Deletes the signed-in person's account, for good: they type their email and (when the account has one) their
 * password. Their sign-ins, sessions, keys and memberships go; a workspace only they were in is deleted with it; in
 * the workspaces they leave, their private conversations and dashboards go and what they shared stays. Refused while
 * they're the only owner of a workspace others are in.
 */
export async function deleteAccountAction(input: { email: string; password: string }): Promise<DeleteAccountResult> {
  const viewer = await requireTenant();
  const user = viewer.user;
  if (typeof input?.email !== "string" || input.email.trim().toLowerCase() !== user.email.trim().toLowerCase()) {
    return { ok: false, field: "email", message: "That isn't your account's email." };
  }
  const database = getAuthDatabase();
  const password = await confirmPassword(database, user.id, input.password);
  if (password === "wrong") return { ok: false, field: "password", message: "That password isn't right." };

  let result: Awaited<ReturnType<typeof deleteAccount>>;
  try {
    // A workspace only they are in goes with the account: its Slack token is given back first, outside the
    // deletion's transaction (which reads the plan again, under a lock, and decides by that one).
    const plan = await accountDeletionPlan(database, user.id);
    if (!plan.blocking.length) for (const w of plan.deleted) await releaseSlack(w.id);
    // What's theirs alone in each workspace they leave goes first, while they can still be told apart as a member:
    // run by the deletion itself, once the account is gone, for each workspace it left.
    result = await deleteAccount(database, user.id, {
      memberRemoved: (orgId, userId) =>
        erasedFromWorkspace(orgId, userId).catch((error: unknown) => {
          console.error(
            JSON.stringify({
              level: "error",
              msg: "a deleted account's own data not removed from a workspace",
              orgId,
              userId,
              error: loggableError(error),
            }),
          );
        }),
    });
  } catch (error) {
    console.error(
      JSON.stringify({ level: "error", msg: "account not deleted", userId: user.id, error: loggableError(error) }),
    );
    return { ok: false, field: null, message: "Your account couldn't be deleted. Nothing was removed: try again." };
  }
  if (!result.deleted) {
    if (result.reason === "sole_owner") {
      const names = result.plan.blocking.map((w) => w.name).join(", ");
      return {
        ok: false,
        field: null,
        message: `You're the only owner of ${names}. Make someone else an owner there, or delete it, then try again.`,
      };
    }
    return { ok: false, field: null, message: "There's no such account any more." };
  }
  console.info(JSON.stringify({ level: "info", msg: "account deleted", userId: user.id }));
  return { ok: true };
}

"use server";

import { authRoutes } from "@opendash/auth/routes";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { enterprise } from "@/enterprise";
import { getAuth } from "@/lib/auth";

export interface FormState {
  error: string | null;
  /** The email-link session is more than a day old; only a new link can finish sign-up. */
  expired?: boolean;
}

const codeOf = (error: unknown) =>
  (error as { body?: { code?: string } })?.body?.code ?? (error as { code?: string })?.code ?? "";

/** Sets the first password, then joins the organization if the person came from an invitation. */
export async function choosePassword(_: FormState, form: FormData): Promise<FormState> {
  const newPassword = String(form.get("password") ?? "");
  const invitationId = String(form.get("invitation") ?? "") || null;
  if (newPassword.length < 10) return { error: "Use at least 10 characters." };
  const requestHeaders = await headers();
  try {
    await getAuth().api.setPassword({ body: { newPassword }, headers: requestHeaders });
  } catch (error) {
    const code = codeOf(error);
    if (code === "PASSWORD_ALREADY_SET") redirect("/");
    if (code.includes("SESSION"))
      return { error: "This page has expired. Request a new link to finish.", expired: true };
    return { error: "We couldn't save your password. Try again." };
  }
  if (invitationId) {
    let joined = true;
    try {
      await getAuth().api.acceptInvitation({ body: { invitationId }, headers: requestHeaders });
    } catch {
      joined = false;
    }
    redirect(joined ? "/" : authRoutes.invitation(invitationId));
  }
  redirect("/");
}

/** Accepts or declines as the signed-in account the invitation is for. */
export async function respondToInvitation(_: FormState, form: FormData): Promise<FormState> {
  const invitationId = String(form.get("invitation") ?? "");
  const accept = form.get("response") !== "decline";
  const requestHeaders = await headers();
  try {
    if (accept) await getAuth().api.acceptInvitation({ body: { invitationId }, headers: requestHeaders });
    else await getAuth().api.rejectInvitation({ body: { invitationId }, headers: requestHeaders });
  } catch {
    return { error: "This invitation is no longer valid. Ask for a new one." };
  }
  redirect("/");
}

/**
 * The sign-in page, email first: whether this address's domain signs in through an identity provider, and whether it
 * must. Says only that (the same a password attempt would reveal), cached per domain for a minute.
 */
export async function discoverSso(email: string): Promise<{ sso: boolean; enforced: boolean }> {
  const sso = enterprise().sso;
  if (!sso || typeof email !== "string" || email.length > 320) return { sso: false, enforced: false };
  return sso.discover(email.trim().toLowerCase());
}

import { toast } from "@heroui/react";
import { authClient } from "@opendash/auth/client";

/** What this tab keeps for whoever is signed in: the analyst panel's conversation, a sign-in link being sent. */
const SIGNED_IN_STATE = ["opendash.panel", "opendash.link-request"];

/**
 * Signs out, forgets what this tab kept for that person, and loads `to` afresh: a full page load, so nothing cached for
 * them (their conversations, the panel's thread) is shown to whoever signs in next in the same tab. When signing out
 * fails, nothing is forgotten and the page stays, saying so (false): they're still signed in, and must know it.
 */
export async function signOutTo(to: string): Promise<boolean> {
  const result = await authClient.signOut().catch(() => null);
  if (!result || result.error) {
    toast.danger("Couldn't sign out. Check your connection and try again.");
    return false;
  }
  try {
    for (const key of Object.keys(sessionStorage)) {
      if (SIGNED_IN_STATE.some((k) => key === k || key.startsWith(`${k}.`))) sessionStorage.removeItem(key);
    }
  } catch {
    // Storage refused (a private window): there's nothing kept to forget.
  }
  window.location.assign(to);
  return true;
}

import "server-only";
import { readUnsubscribeToken, type UnsubscribeTarget } from "@opendash/core";

/** The target an unsubscribe link names, or null for a link that isn't one of ours. */
export function unsubscribeTarget(token: string | null | undefined): UnsubscribeTarget | null {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret || !token) return null;
  return readUnsubscribeToken(secret, token);
}

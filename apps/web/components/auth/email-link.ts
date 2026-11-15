"use client";

import { authClient } from "@opendash/auth/client";
import { authRoutes } from "@opendash/auth/routes";
import { useEffect, useState } from "react";

/** What the sign-up form, the invitation page and the sign-in page ask an email link for. */
export interface LinkRequest {
  email: string;
  name?: string;
  /** Where an existing account lands after opening the link. */
  callbackURL: string;
  /** Where a brand-new account lands: always the password step, sometimes with an invitation to accept. */
  newUserCallbackURL: string;
}

const KEY = "opendash.link-request";

/** Sends the link, and remembers the request so "Check your email" can resend it. */
export async function sendEmailLink(request: LinkRequest) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(request));
  } catch {
    // Private windows can refuse storage; resend then falls back to a plain sign-in link.
  }
  return authClient.signIn.magicLink({ ...request, errorCallbackURL: authRoutes.linkExpired });
}

export function lastLinkRequest(email: string): LinkRequest {
  try {
    const saved = JSON.parse(sessionStorage.getItem(KEY) ?? "null") as LinkRequest | null;
    if (saved?.email === email) return saved;
  } catch {
    // Fall through.
  }
  return { email, callbackURL: "/", newUserCallbackURL: authRoutes.setPassword };
}

/** Seconds until a link can be resent. Better Auth allows 5 link requests a minute per address. */
export function useCooldown(seconds = 60) {
  const [left, setLeft] = useState(seconds);
  useEffect(() => {
    if (left <= 0) return;
    const timer = setTimeout(() => setLeft((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [left]);
  return { left, restart: () => setLeft(seconds) };
}

export const formatCooldown = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

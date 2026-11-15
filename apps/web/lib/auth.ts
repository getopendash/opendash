import "server-only";
import {
  type Auth,
  anyAccount,
  authBaseUrl,
  authRoutes,
  createAuth,
  getAuthDatabase,
  inviteOnlyFromEnv,
  resolveTenant,
  resolveViewer,
  safeRedirectPath,
  type Viewer,
} from "@opendash/auth";
import { mcp, memberLeft } from "@opendash/core";
import { withTenant } from "@opendash/db";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { enterpriseAuth } from "@/enterprise";
import { type HelpLink, helpLinks } from "./help";
import { mcpDeps } from "./mcp";

let instance: Auth | undefined;

/** Created on first use, so `next build` never needs database or key settings. */
export function getAuth(): Auth {
  // A member removed (or leaving) is taken off the workspace's routines at once, and the ones they owned pause; their
  // own connections to MCP servers are removed.
  // Single sign-on comes from ee/ (enterprise.ts), given this server for the plugin's in-process calls.
  instance ??= createAuth({
    memberRemoved: async (orgId, userId) => {
      await withTenant({ orgId }, (tx) => memberLeft(tx, orgId, userId));
      // Their own MCP connections (tokens and keys) go too; the workspace's shared ones stay.
      const deps = mcpDeps();
      if (deps) await mcp.personLeft(deps, orgId, userId);
    },
    extension: enterpriseAuth(() => getAuth()),
  });
  return instance;
}

/** The caller's tenant for API-style requests (session or API key), or null when signed out. */
export async function currentTenant() {
  // Read the request first: it makes the page dynamic before any auth settings are touched.
  const requestHeaders = await headers();
  return resolveTenant(getAuth(), getAuthDatabase(), requestHeaders);
}

/** Where this browser request stands: signed out, mid-sign-up, without a workspace, or in one. */
export async function currentViewer(): Promise<Viewer> {
  const requestHeaders = await headers();
  return resolveViewer(getAuth(), getAuthDatabase(), requestHeaders);
}

/** The page someone in this state belongs on, or null if they can use the app. */
export function nextStep(viewer: Viewer): string | null {
  switch (viewer.kind) {
    case "signed-out":
      return authRoutes.signIn;
    case "needs-password":
      return authRoutes.setPassword;
    case "needs-organization":
      return viewer.pendingInvitationId
        ? authRoutes.invitation(viewer.pendingInvitationId)
        : authRoutes.createOrganization;
    case "left-organization":
      return authRoutes.leftOrganization;
    case "tenant":
      return null;
  }
}

/** Sends anyone who isn't in a workspace to their next step. */
export async function requireTenant() {
  const viewer = await currentViewer();
  const step = nextStep(viewer);
  if (step || viewer.kind !== "tenant") redirect(step ?? authRoutes.signIn);
  return viewer;
}

/** Only same-site paths are followed after signing in, so a link can't bounce someone to another site. */
export const safeNext = safeRedirectPath;

export type Edition = "community" | "cloud";

export interface AuthSettings {
  edition: Edition;
  /** Shown on the community sign-in screen: the address of this instance. */
  host: string;
  /** False on an invite-only instance once it has its first account. */
  signUpOpen: boolean;
  legal: { label: string; href: string }[];
  /** Where to get help on this instance (lib/help.ts): what its operator set. */
  help: HelpLink[];
}

/** Registration and edition settings the auth screens need. Read on each request; they're cheap. */
export async function authSettings(): Promise<AuthSettings> {
  // Per request, never at build time: these come from the running instance's environment and database.
  await connection();
  const edition: Edition = process.env.OPENDASH_EDITION === "cloud" ? "cloud" : "community";
  // The same answer the auth server's registration gate uses: invite-only unless OPENDASH_INVITE_ONLY=0.
  // An invite-only instance nobody has joined yet takes its first sign-up.
  const signUpOpen = !inviteOnlyFromEnv() || !(await anyAccount(getAuthDatabase()));
  const legal = [
    { label: "Terms", href: process.env.OPENDASH_TERMS_URL },
    { label: "Privacy", href: process.env.OPENDASH_PRIVACY_URL },
    { label: "Security", href: process.env.OPENDASH_SECURITY_URL },
  ].filter((l): l is { label: string; href: string } => Boolean(l.href));
  return { edition, host: new URL(authBaseUrl()).host, signUpOpen, legal, help: helpLinks() };
}

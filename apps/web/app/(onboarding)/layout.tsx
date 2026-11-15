import type { Metadata } from "next";
import type { ReactNode } from "react";
import { requireTenant } from "@/lib/auth";

export const metadata: Metadata = { title: "Get started · OpenDash" };

/**
 * The guided setup's pages (/get-started): for someone in a workspace, outside the app's shell, so nothing competes
 * with the one thing each step asks. Anyone not in a workspace is sent to their next step first.
 */
export default async function OnboardingLayout({ children }: { children: ReactNode }) {
  await requireTenant();
  return children;
}

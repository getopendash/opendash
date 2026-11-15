"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth } from "@/lib/auth";

/**
 * After being removed from the session's organization: moves the session to another of the person's organizations,
 * or to none (then onboarding offers a pending invitation or a new organization).
 */
export async function leaveStaleOrganization(): Promise<void> {
  const requestHeaders = await headers();
  const auth = getAuth();
  const orgs = await auth.api.listOrganizations({ headers: requestHeaders }).catch(() => []);
  await auth.api.setActiveOrganization({ body: { organizationId: orgs[0]?.id ?? null }, headers: requestHeaders });
  redirect("/");
}

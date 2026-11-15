"use client";

import { authRoutes } from "@opendash/auth/routes";
import { signOutTo } from "@/lib/sign-out";

/** "Signed in as … · Sign out" for the top right of the invitation and onboarding pages. */
export function SignedInAs({ email }: { email: string }) {
  return (
    <span>
      Signed in as {email} ·{" "}
      <button
        type="button"
        className="cursor-pointer text-link hover:underline"
        onClick={() => signOutTo(authRoutes.signIn)}
      >
        Sign out
      </button>
    </span>
  );
}

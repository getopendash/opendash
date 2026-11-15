import { Button } from "@heroui/react";
import { authRoutes, magicLinkVerifyPath } from "@opendash/auth/routes";
import { LogIn } from "lucide-react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthHeading } from "@/components/auth/auth-heading";
import { AuthScreen } from "@/components/auth/auth-screen";
import { safeNext } from "@/lib/auth";

export const metadata: Metadata = { title: "Continue · OpenDash" };

type Params = Promise<Record<string, string | string[] | undefined>>;

/**
 * Every emailed link lands here. The one-time link only opens when the person presses Continue: mail scanners
 * (Outlook Safe Links, Gmail) fetch links in emails and would otherwise use it up. It reuses the check-your-email
 * layout.
 */
export default async function ContinuePage({ searchParams }: { searchParams: Params }) {
  const params = await searchParams;
  const token = typeof params.token === "string" ? params.token : "";
  if (!token) redirect(`${authRoutes.linkExpired}?error=INVALID_TOKEN`);
  const fields = {
    token,
    callbackURL: safeNext(params.callbackURL) ?? "/",
    newUserCallbackURL: safeNext(params.newUserCallbackURL) ?? authRoutes.setPassword,
    errorCallbackURL: authRoutes.linkExpired,
  };
  return (
    <AuthScreen>
      <form action={magicLinkVerifyPath} method="get" className="flex flex-col gap-6">
        {Object.entries(fields).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
        <AuthHeading icon={LogIn} title="Continue to OpenDash">
          This link signs you in and works once.
        </AuthHeading>
        <Button type="submit" size="lg" fullWidth autoFocus>
          Continue
        </Button>
      </form>
    </AuthScreen>
  );
}

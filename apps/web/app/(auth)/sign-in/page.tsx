import { authRoutes } from "@opendash/auth/routes";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthScreen } from "@/components/auth/auth-screen";
import { SignInForm } from "@/components/auth/sign-in-form";
import { authSettings, currentViewer, safeNext } from "@/lib/auth";

export const metadata: Metadata = { title: "Sign in · OpenDash" };

type Params = Promise<Record<string, string | string[] | undefined>>;

/** Back from single sign-on without a session: what to say (the auth server's and the plugin's reasons). */
function ssoError(params: Record<string, string | string[] | undefined>): string | null {
  const error = typeof params.error === "string" ? params.error : "";
  if (error === "sso_required") return "Your company requires single sign-on for this address.";
  if (error === "sso_unavailable" || error === "SSO_UNAVAILABLE")
    return "Single sign-on isn't available for this address.";
  if (error === "SSO_DOMAIN_MISMATCH")
    return "Your identity provider signed you in with an address its single sign-on doesn't cover.";
  if (params.sso === "failed") return "Single sign-on didn't finish. Try again, or ask your admin.";
  return null;
}

export default async function SignInPage({ searchParams }: { searchParams: Params }) {
  const params = await searchParams;
  const next = safeNext(params.next) ?? "/";
  if ((await currentViewer()).kind !== "signed-out") redirect(next);
  const settings = await authSettings();
  const aside = settings.signUpOpen ? (
    <>
      New to OpenDash?{" "}
      <Link href={authRoutes.signUp} className="text-link hover:underline">
        Create account
      </Link>
    </>
  ) : (
    "No account? Ask your admin for an invite."
  );
  return (
    <AuthScreen aside={aside}>
      <SignInForm next={next} passwordReset={params.reset === "1"} ssoError={ssoError(params)} />
    </AuthScreen>
  );
}

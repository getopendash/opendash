import { authRoutes } from "@opendash/auth/routes";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthScreen } from "@/components/auth/auth-screen";
import { SignUpForm } from "@/components/auth/sign-up-form";
import { authSettings, currentViewer } from "@/lib/auth";

export const metadata: Metadata = { title: "Create account · OpenDash" };

export default async function SignUpPage() {
  if ((await currentViewer()).kind !== "signed-out") redirect("/");
  const settings = await authSettings();
  if (!settings.signUpOpen) redirect(authRoutes.signIn);
  return (
    <AuthScreen
      aside={
        <>
          Already have an account?{" "}
          <Link href={authRoutes.signIn} className="text-link hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <SignUpForm legal={settings.legal} />
    </AuthScreen>
  );
}

import { authRoutes } from "@opendash/auth/routes";
import type { Metadata } from "next";
import Link from "next/link";
import { AuthScreen } from "@/components/auth/auth-screen";
import { CheckEmail } from "@/components/auth/check-email";

export const metadata: Metadata = { title: "Check your email · OpenDash" };

export default async function CheckEmailPage({ searchParams }: { searchParams: Promise<{ email?: string }> }) {
  const { email = "" } = await searchParams;
  return (
    <AuthScreen
      aside={
        <Link href={authRoutes.signIn} className="text-link hover:underline">
          Back to sign in
        </Link>
      }
    >
      <CheckEmail email={email.slice(0, 254)} />
    </AuthScreen>
  );
}

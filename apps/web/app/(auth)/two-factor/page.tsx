import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthScreen } from "@/components/auth/auth-screen";
import { TwoFactorForm } from "@/components/auth/two-factor-form";
import { currentViewer, safeNext } from "@/lib/auth";

export const metadata: Metadata = { title: "Two-factor authentication · OpenDash" };

type Params = Promise<Record<string, string | string[] | undefined>>;

/** Two-factor sign-in: after the password or an email link, for an account with two-factor sign-in. */
export default async function TwoFactorPage({ searchParams }: { searchParams: Params }) {
  const next = safeNext((await searchParams).next) ?? "/";
  if ((await currentViewer()).kind !== "signed-out") redirect(next);
  return (
    <AuthScreen>
      <TwoFactorForm next={next} />
    </AuthScreen>
  );
}

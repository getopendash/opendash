import type { Metadata } from "next";
import { AuthScreen } from "@/components/auth/auth-screen";
import { ForgotPasswordForm } from "@/components/auth/forgot-password-form";
import { RememberedIt } from "@/components/auth/remembered-it";

export const metadata: Metadata = { title: "Reset your password · OpenDash" };

export default function ForgotPasswordPage() {
  return (
    <AuthScreen aside={<RememberedIt />}>
      <ForgotPasswordForm />
    </AuthScreen>
  );
}

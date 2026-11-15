import { authRoutes } from "@opendash/auth/routes";
import Link from "next/link";

/** Top-right line for the forgot-password and reset pages. */
export function RememberedIt() {
  return (
    <>
      Remembered it?{" "}
      <Link href={authRoutes.signIn} className="text-link hover:underline">
        Sign in
      </Link>
    </>
  );
}

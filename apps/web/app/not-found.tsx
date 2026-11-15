import { buttonVariants } from "@heroui/react";
import Link from "next/link";
import { connection } from "next/server";
import { ErrorScreen } from "@/components/errors/error-screen";
import { helpLinks } from "@/lib/help";

/**
 * Any address that isn't a page here (a mistyped link, something deleted): said plainly, with the way back, instead
 * of the framework's bare 404. A page with a better answer of its own (an App that isn't shared any more) keeps it.
 */
export default async function NotFound() {
  // Per request, never at build time: the support address comes from the running instance's environment.
  await connection();
  const support = helpLinks().find((h) => h.id === "support");
  return (
    <ErrorScreen
      full
      title="This page isn't here"
      actions={
        <>
          <Link href="/" className={buttonVariants({ size: "sm" })}>
            Go to OpenDash
          </Link>
          {support ? (
            <a href={support.href} className={buttonVariants({ size: "sm", variant: "outline" })}>
              {support.label}
            </a>
          ) : null}
        </>
      }
    >
      The link may be mistyped, or what it pointed to was deleted or isn't shared with you any more.
    </ErrorScreen>
  );
}

"use client";

import { Button, buttonVariants } from "@heroui/react";
import Link from "next/link";
import { ErrorScreen } from "@/components/errors/error-screen";

/**
 * A page inside the app that failed to draw: the sidebar and the analyst stay, and the page's sheet says so with a
 * way to try again. The reference is the server log line's digest, never the error's own words.
 */
export default function AppPageError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <ErrorScreen
      title="This page couldn't be shown"
      reference={error.digest}
      actions={
        <>
          <Button size="sm" onPress={reset}>
            Try again
          </Button>
          <Link href="/" className={buttonVariants({ size: "sm", variant: "outline" })}>
            Back to home
          </Link>
        </>
      }
    >
      It's on our side, not something you did. Try again in a moment; the rest of OpenDash still works.
    </ErrorScreen>
  );
}

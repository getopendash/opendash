"use client";

import { Button, buttonVariants } from "@heroui/react";
import { ErrorScreen } from "@/components/errors/error-screen";

/**
 * A page that failed to draw (a bug of ours, or the database not answering): said plainly, with a way to try again,
 * instead of the framework's blank "Application error". The server already logged it and reported it where analytics
 * is on (instrumentation.ts); the reference is that log line's digest, never the error's own words.
 */
export default function PageError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <ErrorScreen
      full
      title="Something went wrong"
      reference={error.digest}
      actions={
        <>
          <Button size="sm" onPress={reset}>
            Try again
          </Button>
          <a href="/" className={buttonVariants({ size: "sm", variant: "outline" })}>
            Go to OpenDash
          </a>
        </>
      }
    >
      This page couldn't be shown. It's on our side, not something you did: try again in a moment.
    </ErrorScreen>
  );
}

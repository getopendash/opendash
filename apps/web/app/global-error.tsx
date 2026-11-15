"use client";

import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import { ErrorScreen } from "@/components/errors/error-screen";
import "./globals.css";

/**
 * The last resort: the root layout itself failed, so this draws its own document, with nothing the layout provides
 * (no theme provider, no component library's context): plain links, the tokens' classes. A full reload is the way to
 * try again, since what failed sits above anything `reset` re-draws.
 */
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="bg-background font-sans text-body text-foreground antialiased">
        <ErrorScreen
          full
          title="OpenDash couldn't load"
          reference={error.digest}
          actions={
            <a href="/" className="text-link hover:underline">
              Reload OpenDash
            </a>
          }
        >
          Something on our side broke before the page could be drawn. Try again in a moment.
        </ErrorScreen>
      </body>
    </html>
  );
}

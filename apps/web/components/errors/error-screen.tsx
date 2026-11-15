import type { ReactNode } from "react";

/**
 * What a page that can't be shown says instead (not found, or something of ours broke): a title, a line on what
 * happened, and the ways on. Centred in whatever holds it: the window for the root pages, the page sheet inside the
 * app. No data of its own, so it draws when the rest of the app can't.
 */
export function ErrorScreen({
  title,
  children,
  actions,
  reference,
  full = false,
}: {
  title: string;
  children: ReactNode;
  actions: ReactNode;
  /** The server's digest of the error: what to quote to support, and what finds its log line. */
  reference?: string;
  /** Fills the window (the root pages); otherwise the room its parent gives it. */
  full?: boolean;
}) {
  return (
    <div
      className={`flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center ${full ? "min-h-dvh bg-background" : ""}`}
    >
      <h1 className="text-title">{title}</h1>
      <p className="max-w-sm text-body text-muted">{children}</p>
      <div className="flex flex-wrap items-center justify-center gap-2">{actions}</div>
      {reference ? <p className="font-mono text-small text-muted-tertiary">Reference: {reference}</p> : null}
    </div>
  );
}

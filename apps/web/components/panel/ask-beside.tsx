"use client";

import { Button } from "@heroui/react";
import type { ReactNode } from "react";
import { usePanel } from "./panel-context";

/**
 * "Ask about this" and "Ask about it": a new conversation in the panel beside the page, with a question
 * to start from and the source it's about, rather than a jump to Ask that leaves the page behind.
 */
export function AskBeside({
  text,
  connectionId = null,
  variant = "outline",
  label,
  children,
}: {
  /** A question to start from, ready to send or edit. */
  text?: string;
  /** Where it starts, when the page doesn't name what it shows (an insight's source, a review's). */
  connectionId?: string | null;
  variant?: "outline" | "ghost" | "secondary";
  label?: string;
  children: ReactNode;
}) {
  const panel = usePanel();
  return (
    <Button
      size="sm"
      variant={variant}
      {...(label ? { "aria-label": label } : {})}
      onPress={() => panel.show({ threadId: null, connectionId, ...(text ? { text } : {}) })}
    >
      {children}
    </Button>
  );
}

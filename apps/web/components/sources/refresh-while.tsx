"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Reads the page again every few seconds while it's mounted and its tab is in view: a drafting batch's helpers
 * move on without anyone acting, and the server renders where each is. A hidden tab reads nothing.
 */
export function RefreshWhile({ everyMs }: { everyMs: number }) {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, everyMs);
    return () => clearInterval(timer);
  }, [everyMs, router]);
  return null;
}

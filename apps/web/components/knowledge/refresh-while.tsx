"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Reads the page again every few seconds while something is under way (a definition's tests), then stops. */
export function RefreshWhile({ active, everyMs = 3000 }: { active: boolean; everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => router.refresh(), everyMs);
    return () => clearInterval(timer);
  }, [active, everyMs, router]);
  return null;
}

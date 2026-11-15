"use client";

import { Button } from "@heroui/react";
import { SquareMousePointer } from "lucide-react";
import { useEffect } from "react";
import { setPicking, usePicking } from "./select-mode";

/**
 * Select to edit (its owner's): pressed, the App outlines what the pointer is over and a click adds that piece to the
 * question in the panel beside it. Pressed again, or Escape, leaves. Leaving the page leaves too.
 */
export function SelectToggle({ dashboardId }: { dashboardId: string }) {
  const on = usePicking(dashboardId);
  useEffect(() => () => setPicking(null), []);
  useEffect(() => {
    if (!on) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPicking(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [on]);
  return (
    <Button
      size="sm"
      variant={on ? "secondary" : "ghost"}
      aria-pressed={on}
      onPress={() => setPicking(on ? null : dashboardId)}
    >
      <SquareMousePointer className={`size-3.5 ${on ? "text-accent" : ""}`} aria-hidden />
      Select
    </Button>
  );
}

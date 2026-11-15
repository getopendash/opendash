"use client";

import { Button } from "@heroui/react";
import { PanelLeft, Sparkles } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { usePanelIfAny } from "@/components/panel/panel-context";
import { useShell } from "./shell-context";

export interface Crumb {
  label: string;
  href?: string;
}

/** The sheet's top bar: breadcrumb on the left (and a badge after it, such as "Shared"), one action on the right. */
export function TopBar({ crumbs, badge, action }: { crumbs: Crumb[]; badge?: ReactNode; action?: ReactNode }) {
  const { toggle } = useShell();
  const panel = usePanelIfAny();
  const pathname = usePathname();
  // The analyst beside the page, from every page but Ask, where the page is the conversation.
  const analyst =
    panel && pathname !== "/ask" && !pathname.startsWith("/ask/") ? (
      <Button
        isIconOnly
        size="sm"
        variant={panel.open ? "secondary" : "ghost"}
        aria-label={panel.open ? "Close the analyst (⌘J)" : "Ask the analyst (⌘J)"}
        aria-pressed={panel.open}
        onPress={panel.toggle}
      >
        <Sparkles className="size-4 text-muted" aria-hidden />
      </Button>
    ) : null;
  return (
    // On a narrow sheet (a trace open beside it), the actions wrap onto a second line rather than overlapping the
    // breadcrumb or what's beside the sheet.
    <header className="flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2">
      <div className="flex min-w-32 flex-1 items-center gap-2 overflow-hidden">
        <Button isIconOnly size="md" variant="ghost" aria-label="Show sidebar" onPress={toggle} className="lg:hidden">
          <PanelLeft className="text-muted" />
        </Button>
        <ol className="flex min-w-0 items-center gap-1.5 text-body">
          {crumbs.map((crumb, i) => {
            const last = i === crumbs.length - 1;
            return (
              <li key={crumb.label} className={`flex min-w-0 items-center gap-1.5 ${last ? "" : "shrink"}`}>
                {i > 0 ? (
                  <span aria-hidden className="text-muted-tertiary">
                    /
                  </span>
                ) : null}
                {crumb.href && !last ? (
                  <Link href={crumb.href} className="truncate text-muted hover:text-foreground">
                    {crumb.label}
                  </Link>
                ) : (
                  <span aria-current={last ? "page" : undefined} className="truncate font-medium text-foreground">
                    {crumb.label}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
        {badge ? <span className="shrink-0">{badge}</span> : null}
      </div>
      {action || analyst ? (
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
          {action}
          {analyst}
        </div>
      ) : null}
    </header>
  );
}

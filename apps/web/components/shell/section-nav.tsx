"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

export interface SectionItem {
  label: string;
  href: string;
  /** Shown at the row's end (Members' count). */
  count?: number;
}

export interface SectionGroup {
  title?: string;
  items: SectionItem[];
}

/**
 * A section's own pages, inside the page sheet (Knowledge's, Settings'): a column beside the page, its title level with
 * the page's top bar, or a strip above the page when the sheet is narrow (the analyst's panel beside it, a phone). The
 * page beside it is a container of its own, so its layouts measure the room it has.
 */
export function SectionNav({
  title,
  groups,
  children,
}: {
  title: string;
  groups: SectionGroup[];
  children: ReactNode;
}) {
  const pathname = usePathname();
  const on = (href: string) => pathname === href || pathname.startsWith(`${href}/`);
  return (
    <div className="flex min-h-0 flex-1 flex-col @3xl/page:flex-row">
      <nav
        aria-label={title}
        className="flex shrink-0 gap-0.5 overflow-x-auto border-separator border-b px-3 py-1.5 @3xl/page:w-52 @3xl/page:flex-col @3xl/page:overflow-x-visible @3xl/page:overflow-y-auto @3xl/page:border-r @3xl/page:border-b-0 @3xl/page:px-2 @3xl/page:py-0 @3xl/page:pb-4"
      >
        <span className="hidden min-h-12 shrink-0 items-center px-2 text-body font-semibold text-foreground @3xl/page:flex">
          {title}
        </span>
        {groups.map((group, g) => (
          <div
            key={group.title ?? g}
            className={`flex shrink-0 gap-0.5 @3xl/page:flex-col ${g ? "@3xl/page:pt-3.5" : "@3xl/page:pt-1"}`}
          >
            {group.title ? (
              <span className="hidden px-2 pb-1 text-small text-muted-tertiary @3xl/page:block">{group.title}</span>
            ) : null}
            {group.items.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                aria-current={on(item.href) ? "page" : undefined}
                className={`flex shrink-0 items-center justify-between gap-3 whitespace-nowrap rounded-lg px-2 py-1.5 text-body ${
                  on(item.href) ? "bg-default font-medium text-foreground" : "text-muted hover:bg-default"
                }`}
              >
                {item.label}
                {item.count !== undefined ? (
                  <span className="text-small text-muted-tertiary tabular-nums">{item.count}</span>
                ) : null}
              </Link>
            ))}
          </div>
        ))}
      </nav>
      <div className="@container/page relative flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}

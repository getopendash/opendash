"use client";

import { Tabs } from "@heroui/react";
import { usePathname } from "next/navigation";

/**
 * A source's tabs: Overview, Catalog, and Settings for owners and admins. A page that isn't a tab (Reconnect) shows none.
 */
export function SourceTabs({ id, tables, canManage }: { id: string; tables: number | null; canManage: boolean }) {
  const pathname = usePathname();
  const base = `/data/sources/${id}`;
  const tabs = [
    { key: "overview", href: base, label: "Overview", count: null },
    { key: "catalog", href: `${base}/catalog`, label: "Catalog", count: tables },
    ...(canManage ? [{ key: "settings", href: `${base}/settings`, label: "Settings", count: null }] : []),
  ];
  const selected =
    pathname === base ? "overview" : tabs.find((t) => pathname.startsWith(t.href) && t.key !== "overview")?.key;
  if (!selected) return null;
  return (
    <Tabs variant="secondary" selectedKey={selected} className="border-b border-border">
      <Tabs.ListContainer>
        <Tabs.List aria-label="Source sections">
          {tabs.map((tab) => (
            <Tabs.Tab key={tab.key} id={tab.key} href={tab.href}>
              {tab.label}
              {tab.count ? (
                <span className="ms-1.5 text-small text-muted-tertiary tabular-nums">
                  {tab.count.toLocaleString("en-US")}
                </span>
              ) : null}
              <Tabs.Indicator />
            </Tabs.Tab>
          ))}
        </Tabs.List>
      </Tabs.ListContainer>
    </Tabs>
  );
}

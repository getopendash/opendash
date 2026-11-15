"use client";

import { Tabs } from "@heroui/react";
import type { ReactNode } from "react";

/** A definition page's tabs: Overview, Definition (its YAML), Versions. */
export function DefinitionTabs({ tabs }: { tabs: { id: string; label: string; count?: number; panel: ReactNode }[] }) {
  return (
    <Tabs variant="secondary" defaultSelectedKey={tabs[0]?.id}>
      <Tabs.ListContainer>
        <Tabs.List aria-label="Definition sections">
          {tabs.map((t) => (
            <Tabs.Tab key={t.id} id={t.id}>
              {t.label}
              {t.count !== undefined ? <span className="ms-1 text-small text-muted-tertiary">{t.count}</span> : null}
              <Tabs.Indicator />
            </Tabs.Tab>
          ))}
        </Tabs.List>
      </Tabs.ListContainer>
      {tabs.map((t) => (
        <Tabs.Panel key={t.id} id={t.id} className="px-0 pt-6">
          {t.panel}
        </Tabs.Panel>
      ))}
    </Tabs>
  );
}

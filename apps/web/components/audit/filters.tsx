"use client";

import { ListBox, Select } from "@heroui/react";
import { AUDIT_CATEGORIES, type AuditCategory } from "@opendash/core/audit";
import { usePathname, useRouter } from "next/navigation";

/** The Audit log's filters: a person, a group of actions, a range. Each choice is the page's address (shareable). */
export function AuditFilters({
  who,
  what,
  days,
  actors,
  ranges,
}: {
  who: string | null;
  what: AuditCategory | null;
  days: number;
  actors: { id: string; name: string }[];
  ranges: number[];
}) {
  const router = useRouter();
  const path = usePathname();
  const go = (next: { who?: string | null; what?: string | null; days?: number }) => {
    const p = new URLSearchParams();
    const w = next.who === undefined ? who : next.who;
    const c = next.what === undefined ? what : next.what;
    if (w) p.set("who", w);
    if (c) p.set("what", c);
    p.set("days", String(next.days ?? days));
    router.push(`${path}?${p}`);
  };
  const people = [{ id: "all", name: "Everyone" }, ...actors];
  const groups = [["all", "All actions"], ...Object.entries(AUDIT_CATEGORIES)] as const;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        aria-label="Person"
        selectedKey={who ?? "all"}
        onSelectionChange={(k) => go({ who: k === "all" ? null : String(k) })}
        className="w-48"
      >
        <Select.Trigger className="h-8">
          <Select.Value />
          <Select.Indicator />
        </Select.Trigger>
        <Select.Popover className="w-56">
          <ListBox>
            {people.map((p) => (
              <ListBox.Item key={p.id} id={p.id} textValue={p.name}>
                {p.name}
                <ListBox.ItemIndicator />
              </ListBox.Item>
            ))}
          </ListBox>
        </Select.Popover>
      </Select>
      <Select
        aria-label="Action"
        selectedKey={what ?? "all"}
        onSelectionChange={(k) => go({ what: k === "all" ? null : String(k) })}
        className="w-48"
      >
        <Select.Trigger className="h-8">
          <Select.Value />
          <Select.Indicator />
        </Select.Trigger>
        <Select.Popover className="w-56">
          <ListBox>
            {groups.map(([id, label]) => (
              <ListBox.Item key={id} id={id} textValue={label}>
                {label}
                <ListBox.ItemIndicator />
              </ListBox.Item>
            ))}
          </ListBox>
        </Select.Popover>
      </Select>
      <Select
        aria-label="Range"
        selectedKey={String(days)}
        onSelectionChange={(k) => go({ days: Number(k) })}
        className="w-40"
      >
        <Select.Trigger className="h-8">
          <Select.Value />
          <Select.Indicator />
        </Select.Trigger>
        <Select.Popover className="w-44">
          <ListBox>
            {ranges.map((d) => (
              <ListBox.Item key={d} id={String(d)} textValue={rangeLabel(d)}>
                {rangeLabel(d)}
                <ListBox.ItemIndicator />
              </ListBox.Item>
            ))}
          </ListBox>
        </Select.Popover>
      </Select>
    </div>
  );
}

const rangeLabel = (d: number) =>
  d === 365 ? "Last year" : d > 365 ? `Last ${Math.round(d / 365)} years` : `Last ${d} days`;

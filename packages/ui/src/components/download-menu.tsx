"use client";

import { Button, buttonVariants, Dropdown, Label } from "@heroui/react";
import { Download } from "lucide-react";

export interface DownloadItem {
  href: string;
  label: string;
}

/**
 * A download: one file is a link, several are a menu of them by name. `icon` draws it as a small icon by a table's or
 * a chart's label. `onOpenChange` lets the caller name the files only when the menu opens.
 */
export function DownloadMenu({
  items,
  label = "CSV",
  what,
  icon = false,
  onOpenChange,
}: {
  items: DownloadItem[];
  /** The button's word (absent as an icon). */
  label?: string;
  /** What the files are, for screen readers and the menu. */
  what: string;
  icon?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  if (!items.length) return null;
  const face = (
    <>
      <Download className="size-3.5" aria-hidden />
      {icon ? null : label}
    </>
  );
  const [only] = items;
  if (items.length === 1 && only) {
    const look = icon
      ? `${buttonVariants({ size: "sm", variant: "ghost", isIconOnly: true })} text-muted`
      : `${buttonVariants({ size: "sm", variant: "ghost" })} gap-1.5`;
    return (
      <a href={only.href} download className={look} aria-label={`Download ${label}: ${what}`} title={what}>
        {face}
      </a>
    );
  }
  return (
    <Dropdown {...(onOpenChange ? { onOpenChange } : {})}>
      <Button
        size="sm"
        variant="ghost"
        isIconOnly={icon}
        aria-label={`Download ${label}: ${what}`}
        className={icon ? "text-muted" : "gap-1.5"}
      >
        {face}
      </Button>
      <Dropdown.Popover placement="bottom end" className="min-w-56">
        <Dropdown.Menu aria-label={what} onAction={(key) => window.location.assign(String(key))}>
          {items.map((item) => (
            <Dropdown.Item key={item.href} id={item.href} textValue={item.label}>
              <Label>{item.label}</Label>
            </Dropdown.Item>
          ))}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}

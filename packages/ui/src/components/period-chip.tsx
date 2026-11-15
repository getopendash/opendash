"use client";

import { Button, Popover } from "@heroui/react";
import { Calendar, Check, ChevronDown, RotateCcw } from "lucide-react";
import { useState } from "react";

/**
 * A dashboard's period: a chip that reads "Period" until one is chosen, then its label ("Last 90
 * days") in the accent. Its popover lists the presets and a custom range (two days, the end included); "Each tile's
 * own window" clears it. The owner also gets "Remove filter".
 */
export function PeriodChip({
  label,
  value,
  display,
  presets,
  onApply,
  onRemove,
  note,
}: {
  label: string;
  /** The chosen period: a preset, or a range `2026-07-01..2026-09-30`; null when none is. */
  value: string | null;
  /** How the chosen period reads: "Last 90 days", "1 Jul – 30 Sep 2026". */
  display: string | null;
  presets: { value: string; label: string }[];
  onApply: (value: string | null) => void;
  onRemove?: () => void;
  note?: string;
}) {
  const [open, setOpen] = useState(false);
  const [from, through] = value?.includes("..") ? value.split("..") : ["", ""];
  const [start, setStart] = useState(from ?? "");
  const [end, setEnd] = useState(through ?? "");
  const choose = (next: string | null) => {
    setOpen(false);
    if (next !== value) onApply(next);
  };
  const custom = start && end && start <= end ? `${start}..${end}` : null;
  return (
    <Popover
      isOpen={open}
      onOpenChange={(o) => {
        if (o) {
          setStart(from ?? "");
          setEnd(through ?? "");
        }
        setOpen(o);
      }}
    >
      <Button
        size="sm"
        variant="outline"
        className={value ? "border-accent bg-accent-soft text-accent-soft-foreground" : ""}
        aria-label={value ? `Period: ${display ?? value}` : "Choose a period"}
      >
        <Calendar className="size-3.5" aria-hidden />
        <span className="max-w-48 truncate">{value ? (display ?? value) : label}</span>
        <ChevronDown className="size-3" aria-hidden />
      </Button>
      <Popover.Content placement="bottom start" className="w-72">
        <Popover.Dialog className="flex flex-col gap-1 p-1">
          <Popover.Heading className="px-2 pt-1 text-small font-semibold text-muted">{label}</Popover.Heading>
          <button
            type="button"
            className="flex h-8 items-center gap-2 rounded-lg px-2 text-left text-small text-muted hover:bg-default"
            onClick={() => choose(null)}
          >
            <RotateCcw className="size-3.5" aria-hidden />
            Each tile's own window
          </button>
          {presets.map((p) => (
            <button
              key={p.value}
              type="button"
              aria-pressed={p.value === value}
              className={`flex h-8 items-center gap-2 rounded-lg px-2 text-left text-small hover:bg-default ${p.value === value ? "bg-default" : ""}`}
              onClick={() => choose(p.value)}
            >
              {p.value === value ? (
                <Check className="size-3.5" aria-hidden />
              ) : (
                <Calendar className="size-3.5 text-muted" aria-hidden />
              )}
              {p.label}
            </button>
          ))}
          <div className="mx-1 my-1 border-t border-border" />
          <div className="flex flex-col gap-2 px-2 pb-1">
            <span className="text-small font-medium text-muted">Custom range</span>
            <div className="flex items-center gap-2">
              <input
                type="date"
                aria-label="From"
                value={start}
                onChange={(e) => setStart(e.target.value)}
                className="h-8 min-w-0 flex-1 rounded-xl border border-border bg-transparent px-2 text-small"
              />
              <span className="text-muted-tertiary">–</span>
              <input
                type="date"
                aria-label="Through"
                value={end}
                min={start || undefined}
                onChange={(e) => setEnd(e.target.value)}
                className="h-8 min-w-0 flex-1 rounded-xl border border-border bg-transparent px-2 text-small"
              />
            </div>
            <div className="flex items-center gap-2">
              {onRemove ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-danger"
                  onPress={() => {
                    setOpen(false);
                    onRemove();
                  }}
                >
                  Remove filter
                </Button>
              ) : null}
              <span className="flex-1" />
              <Button size="sm" isDisabled={!custom || custom === value} onPress={() => choose(custom)}>
                Apply
              </Button>
            </div>
            {note ? <p className="text-small text-muted-tertiary">{note}</p> : null}
          </div>
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  );
}

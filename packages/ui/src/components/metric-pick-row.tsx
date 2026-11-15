"use client";

import { Checkbox } from "@heroui/react";
import { Sparkline } from "./sparkline";

/**
 * A metric to pick for a routine that watches: its name, how it's checked and its latest value, how many
 * routines watch it already, and its recent periods as a sparkline when it has been checked.
 */
export function MetricPickRow({
  title,
  detail,
  watchedBy,
  values,
  selected,
  disabled,
  onChange,
}: {
  title: string;
  /** "Weekly · $412.6k last week", or "Monthly" before its first check. */
  detail: string;
  /** How many routines watch it already. */
  watchedBy: number;
  values?: (number | null)[];
  selected: boolean;
  disabled?: boolean;
  onChange: (selected: boolean) => void;
}) {
  return (
    <Checkbox
      isSelected={selected}
      isDisabled={disabled}
      onChange={onChange}
      className="metric-pick-row"
      data-selected={selected ? "" : undefined}
    >
      <Checkbox.Content className="w-full items-center">
        <Checkbox.Control>
          <Checkbox.Indicator />
        </Checkbox.Control>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-body">{title}</span>
          <span className="truncate text-small text-muted">{detail}</span>
        </span>
        <span className="shrink-0 text-small text-muted">
          {watchedBy ? `Watched by ${watchedBy} ${watchedBy === 1 ? "routine" : "routines"}` : "Not watched yet"}
        </span>
        {values && values.length > 1 ? <Sparkline values={values} className="h-5 w-16 shrink-0" /> : null}
      </Checkbox.Content>
    </Checkbox>
  );
}

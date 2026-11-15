"use client";

import { ToggleButton, ToggleButtonGroup } from "@heroui/react";

const DAYS = [
  { id: "mon", label: "Mon", name: "Monday" },
  { id: "tue", label: "Tue", name: "Tuesday" },
  { id: "wed", label: "Wed", name: "Wednesday" },
  { id: "thu", label: "Thu", name: "Thursday" },
  { id: "fri", label: "Fri", name: "Friday" },
  { id: "sat", label: "Sat", name: "Saturday" },
  { id: "sun", label: "Sun", name: "Sunday" },
] as const;

export type DayId = (typeof DAYS)[number]["id"];

/** The days a weekly routine runs on: one or several, Monday first, never none. */
export function DayPicker({
  value,
  onChange,
  disabled,
  single,
}: {
  value: DayId[];
  onChange: (days: DayId[]) => void;
  disabled?: boolean;
  /** One day only (a weekly summary goes out once a week). */
  single?: boolean;
}) {
  return (
    <ToggleButtonGroup
      aria-label="Days"
      selectionMode={single ? "single" : "multiple"}
      disallowEmptySelection
      isDisabled={disabled}
      selectedKeys={new Set(value)}
      onSelectionChange={(keys) => {
        const picked = DAYS.map((d) => d.id).filter((d) => keys.has(d));
        if (picked.length) onChange(picked);
      }}
      size="sm"
      className="w-fit"
    >
      {DAYS.map((d, i) => (
        <ToggleButton key={d.id} id={d.id} aria-label={d.name}>
          {i ? <ToggleButtonGroup.Separator /> : null}
          {d.label}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}

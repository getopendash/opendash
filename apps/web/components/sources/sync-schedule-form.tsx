"use client";

import { Button, Label, ListBox, Select, toast } from "@heroui/react";
import type { SyncSchedule } from "@opendash/core";
import { useState, useTransition } from "react";
import { setSyncScheduleAction } from "@/app/(app)/data/sources/actions";

const EVERY = [
  { id: "day", label: "Daily" },
  { id: "6h", label: "Every 6 hours" },
  { id: "off", label: "Off (Sync now only)" },
] as const;
const HOURS = Array.from({ length: 24 }, (_, h) => ({ id: String(h), label: `${String(h).padStart(2, "0")}:00 UTC` }));

/** Sync: how often the source is learned again on its own. Each sync also notices schema changes. */
export function SyncScheduleForm({ id, schedule }: { id: string; schedule: SyncSchedule }) {
  const [every, setEvery] = useState<SyncSchedule["every"]>(schedule.every);
  const [hour, setHour] = useState(schedule.every === "day" ? schedule.hour : 2);
  const [pending, start] = useTransition();
  const next: SyncSchedule = every === "day" ? { every, hour } : { every };
  const changed = JSON.stringify(next) !== JSON.stringify(schedule);
  return (
    <form
      className="flex items-end gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        start(async () => {
          const result = await setSyncScheduleAction(id, next);
          if (result?.message) toast.danger(result.message);
          else toast.success("Schedule saved");
        });
      }}
    >
      <Select className="w-48" value={every} onChange={(key) => setEvery(String(key) as SyncSchedule["every"])}>
        <Label>Learn again</Label>
        <Select.Trigger>
          <Select.Value />
          <Select.Indicator />
        </Select.Trigger>
        <Select.Popover>
          <ListBox>
            {EVERY.map((e) => (
              <ListBox.Item key={e.id} id={e.id} textValue={e.label}>
                {e.label}
                <ListBox.ItemIndicator />
              </ListBox.Item>
            ))}
          </ListBox>
        </Select.Popover>
      </Select>
      {every === "day" ? (
        <Select className="w-36" value={String(hour)} onChange={(key) => setHour(Number(key))}>
          <Label>At</Label>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              {HOURS.map((h) => (
                <ListBox.Item key={h.id} id={h.id} textValue={h.label}>
                  {h.label}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
      ) : null}
      <Button type="submit" variant="outline" isDisabled={!changed} isPending={pending}>
        Save schedule
      </Button>
    </form>
  );
}

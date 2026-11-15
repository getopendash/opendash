"use client";

import { Label, ListBox, Select, toast } from "@heroui/react";
import { useMemo, useState } from "react";
import { setWorkspaceTzAction } from "@/app/(app)/routines/actions";
import { answerOf } from "@/lib/action-answer";

/** The workspace's time zone, where its routines run and its metrics are checked: owners and admins change it. */
export function WorkspaceTz({ tz: initial, canManage }: { tz: string; canManage: boolean }) {
  const [tz, setTz] = useState(initial);
  const [pending, setPending] = useState(false);
  // The browser's list leaves out plain "UTC" (it has Etc/UTC): the workspace's own zone is always offered.
  const zones = useMemo(() => {
    const all = Intl.supportedValuesOf("timeZone");
    return all.includes(initial) ? all : [initial, ...all];
  }, [initial]);
  const save = async (next: string) => {
    setPending(true);
    const r = await answerOf(() => setWorkspaceTzAction(next));
    setPending(false);
    if (!r.ok) {
      toast.danger(r.message);
      return;
    }
    setTz(next);
    toast.success("Saved: every routine runs at its time in it, and its next times moved with it.");
  };
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface px-4 py-3">
      <span className="flex flex-col gap-0.5">
        <span className="text-body font-medium">Time zone</span>
        <span className="text-small text-muted">
          The workspace's: routines run at their times in it, and metrics are checked at 06:00 in it.
        </span>
      </span>
      {canManage ? (
        <Select
          aria-label="Time zone"
          value={tz}
          isDisabled={pending}
          onChange={(key) => {
            const next = String(key ?? tz);
            if (next !== tz) void save(next);
          }}
          className="w-60"
        >
          <Label className="sr-only">Time zone</Label>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              {zones.map((z) => (
                <ListBox.Item key={z} id={z} textValue={z}>
                  {z}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
      ) : (
        <span className="text-body text-muted">{tz}</span>
      )}
    </div>
  );
}

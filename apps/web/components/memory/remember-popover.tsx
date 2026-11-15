"use client";

import { Button, Checkbox, Input, Popover, TextField, toast } from "@heroui/react";
import { Bookmark } from "lucide-react";
import { useState, useTransition } from "react";
import { forgetAction, rememberAction } from "@/app/(app)/knowledge/memory/actions";

/** A toast that says what was remembered, with Undo. */
export function rememberedToast(saved: { id: string; fact: string }[]) {
  toast.success(
    saved.length === 1 ? `Saved to your memory: “${saved[0]?.fact}”` : `Saved ${saved.length} things to your memory.`,
    {
      actionProps: {
        children: "Undo",
        onPress: () => void forgetAction(saved.map((s) => s.id)).then(() => toast.info("Forgotten.")),
      },
    },
  );
}

/**
 * "Remember" on an answer. The person picks what to keep from how the answer read their question, or writes it
 * their way; it's theirs alone and never a definition.
 */
export function RememberPopover({ readings, threadId }: { readings: string[]; threadId: string }) {
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [own, setOwn] = useState("");
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const facts = [...readings.filter((_, i) => picked.has(i)), ...(own.trim() ? [own.trim()] : [])];
  const save = () =>
    start(async () => {
      const r = await rememberAction({ facts, threadId });
      if ("message" in r) {
        toast.danger(r.message);
        return;
      }
      setOpen(false);
      setPicked(new Set());
      setOwn("");
      rememberedToast(r.saved);
    });
  return (
    <Popover isOpen={open} onOpenChange={setOpen}>
      <Button size="sm" variant="ghost">
        <Bookmark className="size-3.5" aria-hidden />
        Remember
      </Button>
      <Popover.Content placement="top start" className="w-96">
        <Popover.Dialog className="flex flex-col gap-3 p-1">
          <Popover.Heading className="text-body font-semibold">Remember for your next questions</Popover.Heading>
          <p className="text-small text-muted">
            How this answer read your question. Keep what you want it to read the same way next time.
          </p>
          {readings.length ? (
            <div className="flex flex-col gap-1">
              {readings.map((r, i) => (
                <Checkbox
                  key={r}
                  isSelected={picked.has(i)}
                  onChange={(on) => {
                    const next = new Set(picked);
                    if (on) next.add(i);
                    else next.delete(i);
                    setPicked(next);
                  }}
                  className="flex flex-row items-start gap-2 rounded-lg px-1 py-1 hover:bg-default"
                >
                  <Checkbox.Control>
                    <Checkbox.Indicator />
                  </Checkbox.Control>
                  <Checkbox.Content className="text-small">{r}</Checkbox.Content>
                </Checkbox>
              ))}
            </div>
          ) : null}
          <TextField value={own} onChange={setOwn} aria-label="Or write it your way">
            <Input placeholder="Or write it your way…" maxLength={300} />
          </TextField>
          <p className="text-small text-muted-tertiary">Only you see it, and it never changes a verified definition.</p>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onPress={() => setOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" isPending={pending} isDisabled={!facts.length} onPress={save}>
              <Bookmark className="size-3.5" aria-hidden />
              {facts.length > 1 ? `Remember ${facts.length}` : "Remember"}
            </Button>
          </div>
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  );
}

"use client";

import { Button, Input, Label, Popover, TextField } from "@heroui/react";
import { ChevronDown, RotateCcw } from "lucide-react";
import { useState } from "react";
import { READING_MAX, rereadQuestion } from "@/lib/readings";

/**
 * Change how an answer read one part of its question. The chip's chevron opens it; "Ask again" asks the question
 * again in this conversation, with the new reading as an instruction.
 */
export function ReadingPopover({
  reading,
  question,
  onAsk,
}: {
  reading: string;
  question: string;
  onAsk: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(reading);
  const text = rereadQuestion(question, reading, draft);
  return (
    <Popover
      isOpen={open}
      onOpenChange={(next) => {
        if (next) setDraft(reading);
        setOpen(next);
      }}
    >
      <Button
        isIconOnly
        size="sm"
        variant="ghost"
        aria-label={`Change the reading “${reading}”`}
        className="size-4 min-w-0 rounded-md text-muted-tertiary hover:text-foreground"
      >
        <ChevronDown className="size-2.5" aria-hidden />
      </Button>
      <Popover.Content placement="bottom start" className="w-80">
        <Popover.Dialog className="p-1">
          <form
            className="flex flex-col gap-2.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (!text) return;
              setOpen(false);
              onAsk(text);
            }}
          >
            <div className="flex flex-col gap-1">
              <Popover.Heading className="text-small font-normal text-muted">OpenDash read this as</Popover.Heading>
              <p className="text-body font-medium">{reading}</p>
            </div>
            <TextField value={draft} onChange={setDraft} className="flex flex-col gap-1.5">
              <Label>Read it as</Label>
              <Input autoFocus maxLength={READING_MAX} />
            </TextField>
            <p className="text-small text-muted-tertiary">Asks again in this conversation, with your reading.</p>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onPress={() => setOpen(false)}>
                Cancel
              </Button>
              <Button size="sm" type="submit" isDisabled={!text}>
                <RotateCcw className="size-3.5" aria-hidden />
                Ask again
              </Button>
            </div>
          </form>
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  );
}

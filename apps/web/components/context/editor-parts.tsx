"use client";

import { Button, Input, Label, TextField, toast } from "@heroui/react";
import { ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { approveContextAction } from "@/app/(app)/knowledge/context-actions";

type Saved = { id: string; version: number } | { message: string };

/** Saves a term, guide or skill, then approves it when asked, and opens its page. */
export function useSave(kind: "glossary" | "guides" | "skills") {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [problem, setProblem] = useState<string | null>(null);
  const run = (save: () => Promise<Saved>, approve: boolean) =>
    start(async () => {
      setProblem(null);
      const r = await save();
      if ("message" in r) {
        setProblem(r.message);
        return;
      }
      if (approve) {
        const a = await approveContextAction([{ id: r.id, version: r.version }]);
        if ("message" in a) toast.danger(a.message);
        else toast.success(`Approved version ${r.version}: the analyst reads it from the next question.`);
      } else {
        toast.success(`Saved version ${r.version} as a draft.`);
      }
      router.push(`/knowledge/${kind}/${r.id}`);
      router.refresh();
    });
  return { pending, problem, run };
}

/** The editors' footer: the change note, any problem, and Cancel, Save draft, Save and approve. */
export const Footer = ({
  note,
  setNote,
  pending,
  problem,
  onCancel,
  onSave,
  disabled,
  draftOf,
}: {
  note: string;
  setNote: (n: string) => void;
  pending: boolean;
  problem: string | null;
  onCancel: () => void;
  onSave: (approve: boolean) => void;
  disabled?: boolean;
  draftOf: number | null;
}) => (
  <>
    <TextField value={note} onChange={setNote} className="flex flex-col gap-1.5">
      <Label>Change note</Label>
      <Input placeholder="What changed, for Versions" maxLength={300} />
    </TextField>
    {problem ? <p className="text-small text-danger">{problem}</p> : null}
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
      <span className="text-small text-muted-tertiary">
        {draftOf
          ? `Saving makes a draft of version ${draftOf + 1}; the analyst reads version ${draftOf} until it's approved.`
          : "A draft reaches the analyst only once an admin approves it."}
      </span>
      <span className="flex gap-2">
        <Button variant="ghost" onPress={onCancel}>
          Cancel
        </Button>
        <Button variant="outline" isPending={pending} isDisabled={disabled} onPress={() => onSave(false)}>
          Save draft
        </Button>
        <Button isPending={pending} isDisabled={disabled} onPress={() => onSave(true)}>
          <ShieldCheck className="size-3.5" aria-hidden />
          Save and approve
        </Button>
      </span>
    </div>
  </>
);

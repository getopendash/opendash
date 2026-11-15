"use client";

import { Button, Label, Modal, TextArea, TextField, toast } from "@heroui/react";
import { X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { rejectDraftAction } from "@/app/(app)/knowledge/proposals/actions";

/** Rejects one draft with a note the next draft of its table reads; a dataset takes its metrics along. */
export function RejectDraft({ id, title, dataset }: { id: string; title: string; dataset: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const reject = () =>
    start(async () => {
      const r = await rejectDraftAction(id, note);
      if (!r.ok) {
        toast.danger(r.message);
        return;
      }
      toast.success(`Rejected ${title}. The next draft of its table reads your note.`);
      setOpen(false);
      router.refresh();
    });
  return (
    <>
      <Button size="sm" variant="outline" onPress={() => setOpen(true)}>
        <X className="size-3.5" aria-hidden />
        Reject
      </Button>
      <Modal>
        <Modal.Backdrop isOpen={open} onOpenChange={setOpen}>
          <Modal.Container size="sm">
            <Modal.Dialog>
              <Modal.Header>
                <Modal.Heading>Reject {title}</Modal.Heading>
              </Modal.Header>
              <Modal.Body className="flex flex-col gap-2">
                <TextField value={note} onChange={setNote} autoFocus className="flex flex-col gap-1.5">
                  <Label>What's wrong with it</Label>
                  <TextArea rows={3} maxLength={1000} placeholder="Count only accounts with a subscription." />
                </TextField>
                <p className="text-small text-muted-tertiary">
                  {dataset ? "The metrics drafted on it go too. " : ""}Your note goes to the next draft of its table.
                </p>
              </Modal.Body>
              <Modal.Footer className="flex justify-end gap-2">
                <Button variant="ghost" slot="close">
                  Cancel
                </Button>
                <Button variant="danger" isPending={pending} onPress={reject}>
                  Reject
                </Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </>
  );
}

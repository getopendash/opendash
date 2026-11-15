"use client";

import { Button, Label, Modal, TextArea, TextField, toast } from "@heroui/react";
import { Check, Pencil, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { approveProposalAction, rejectProposalAction } from "@/app/(app)/knowledge/proposals/actions";

/**
 * The actions on a Modeler proposal in review: Approve its definitions (all of them, as they hold together), Edit
 * one (its page, where a change is a new version reviewed with it), or Reject with a note for its next draft.
 */
export function ProposalActions({
  proposalId,
  count,
  edits,
  canApprove,
}: {
  proposalId: string;
  count: number;
  /** Each draft's page, to edit it before approving. */
  edits: { label: string; href: string }[];
  canApprove: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const run = (action: () => Promise<{ ok: true } | { ok: false; message: string }>, done: string) =>
    start(async () => {
      const r = await action();
      if (!r.ok) {
        toast.danger(r.message);
        return;
      }
      toast.success(done);
      setRejecting(false);
      router.refresh();
    });
  return (
    <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3">
      {edits.map((e) => (
        <Link
          key={e.href}
          href={e.href}
          className="flex h-8 items-center gap-1.5 rounded-xl border border-border px-3 text-body hover:bg-default"
        >
          <Pencil className="size-3.5" aria-hidden />
          {e.label}
        </Link>
      ))}
      {canApprove ? (
        <>
          <Button size="sm" variant="outline" onPress={() => setRejecting(true)} isDisabled={pending}>
            <X className="size-3.5" aria-hidden />
            Reject
          </Button>
          <Button
            size="sm"
            isPending={pending}
            onPress={() =>
              run(
                () => approveProposalAction(proposalId),
                "Approved: Ask, dashboards and routines use it now. Its tile offers to switch.",
              )
            }
          >
            <Check className="size-3.5" aria-hidden />
            Approve {count === 1 ? "the definition" : `${count} definitions`}
          </Button>
        </>
      ) : (
        <span className="text-small text-muted-tertiary">An owner or admin approves it.</span>
      )}
      <Modal>
        <Modal.Backdrop isOpen={rejecting} onOpenChange={setRejecting}>
          <Modal.Container size="sm">
            <Modal.Dialog>
              <Modal.Header>
                <Modal.Heading>Reject this draft</Modal.Heading>
              </Modal.Header>
              <Modal.Body className="flex flex-col gap-2">
                <TextField value={note} onChange={setNote} autoFocus className="flex flex-col gap-1.5">
                  <Label>What's wrong with it</Label>
                  <TextArea rows={3} maxLength={1000} placeholder="Count accounts, not subscriptions." />
                </TextField>
                <p className="text-small text-muted-tertiary">Its drafts are deleted. Your note stays with it.</p>
              </Modal.Body>
              <Modal.Footer className="flex justify-end gap-2">
                <Button variant="ghost" slot="close">
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  isPending={pending}
                  onPress={() => run(() => rejectProposalAction(proposalId, note), "Rejected.")}
                >
                  Reject
                </Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </div>
  );
}

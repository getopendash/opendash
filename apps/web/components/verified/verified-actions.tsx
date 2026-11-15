"use client";

import { AlertDialog, Button, toast } from "@heroui/react";
import type { VerifiedQuerySpec } from "@opendash/core";
import { Pencil, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { deleteVerifiedAction } from "@/app/(app)/knowledge/verified/actions";
import { VerifyDialog } from "./verify-dialog";

/** A verified query's actions for owners and admins: edit the question and wordings (a new version), or delete. */
export function VerifiedActions({
  id,
  spec,
  titles,
}: {
  id: string;
  spec: VerifiedQuerySpec;
  titles: Record<string, string>;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [pending, start] = useTransition();
  return (
    <span className="flex items-center gap-1.5">
      <Button size="sm" variant="outline" onPress={() => setEditing(true)}>
        <Pencil className="size-3.5" aria-hidden />
        Edit
      </Button>
      <Button isIconOnly size="sm" variant="ghost" aria-label="Delete" onPress={() => setDeleting(true)}>
        <Trash2 className="size-4" aria-hidden />
      </Button>
      <VerifyDialog
        target={{ id }}
        question={spec.question}
        phrasings={spec.phrasings}
        spec={spec.query}
        titles={titles}
        isOpen={editing}
        onOpenChange={setEditing}
      />
      <AlertDialog>
        <AlertDialog.Backdrop isOpen={deleting} onOpenChange={setDeleting}>
          <AlertDialog.Container>
            <AlertDialog.Dialog>
              <AlertDialog.Header>
                <AlertDialog.Heading>Delete this verified query?</AlertDialog.Heading>
              </AlertDialog.Header>
              <AlertDialog.Body>
                <p className="text-body text-muted">The analyst stops being given it from the next question.</p>
              </AlertDialog.Body>
              <AlertDialog.Footer>
                <Button variant="ghost" slot="close">
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  isPending={pending}
                  onPress={() =>
                    start(async () => {
                      const r = await deleteVerifiedAction(id);
                      if (r.message) toast.danger(r.message);
                      router.push("/knowledge/verified");
                      router.refresh();
                    })
                  }
                >
                  Delete
                </Button>
              </AlertDialog.Footer>
            </AlertDialog.Dialog>
          </AlertDialog.Container>
        </AlertDialog.Backdrop>
      </AlertDialog>
    </span>
  );
}

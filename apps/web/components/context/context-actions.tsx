"use client";

import { AlertDialog, Button, buttonVariants, toast } from "@heroui/react";
import { Pencil, ShieldCheck, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { approveContextAction, deleteContextAction } from "@/app/(app)/knowledge/context-actions";

/** A term's, guide's or skill's top-bar actions: Edit, Approve (this version), Delete. Admins only. */
export function ContextActions({
  id,
  version,
  status,
  kind,
  title,
}: {
  id: string;
  version: number;
  status: string;
  kind: "glossary" | "guides" | "skills";
  title: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [deleting, setDeleting] = useState(false);
  return (
    <span className="flex items-center gap-1.5">
      {status !== "verified" ? (
        <Button
          size="sm"
          isPending={pending}
          onPress={() =>
            start(async () => {
              const r = await approveContextAction([{ id, version }]);
              if ("message" in r) toast.danger(r.message);
              else if (r.approved) toast.success(`Approved version ${version}.`);
              else toast.danger("A newer version was saved meanwhile: open it to review it.");
              router.refresh();
            })
          }
        >
          <ShieldCheck className="size-3.5" aria-hidden />
          Approve v{version}
        </Button>
      ) : null}
      <Link
        href={`/knowledge/${kind}/${id}/edit`}
        className={`${buttonVariants({ size: "sm", variant: "outline" })} gap-1`}
      >
        <Pencil className="size-3.5" aria-hidden />
        Edit
      </Link>
      <Button isIconOnly size="sm" variant="ghost" aria-label="Delete" onPress={() => setDeleting(true)}>
        <Trash2 className="size-4" aria-hidden />
      </Button>
      <AlertDialog>
        <AlertDialog.Backdrop isOpen={deleting} onOpenChange={setDeleting}>
          <AlertDialog.Container>
            <AlertDialog.Dialog>
              <AlertDialog.Header>
                <AlertDialog.Heading>Delete {title}?</AlertDialog.Heading>
              </AlertDialog.Header>
              <AlertDialog.Body>
                <p className="text-body text-muted">The analyst stops reading it from the next question.</p>
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
                      const r = await deleteContextAction(id);
                      if (r.message) toast.danger(r.message);
                      router.push(`/knowledge/${kind}`);
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

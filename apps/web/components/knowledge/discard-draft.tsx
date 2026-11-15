"use client";

import { Button, Modal, toast } from "@heroui/react";
import { Undo2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { discardDraftAction } from "@/app/(app)/knowledge/draft-actions";

/**
 * Discards a definition's draft: it's back at its released version, which Ask goes on using. The draft
 * stays in its versions. Confirmed first: there's no Undo for it.
 */
export function DiscardDraft({
  id,
  title,
  version,
  releasedVersion,
}: {
  id: string;
  title: string;
  version: number;
  releasedVersion: number;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const discard = () =>
    start(async () => {
      const r = await discardDraftAction(id, version);
      if (!r.ok) {
        toast.danger(r.message);
        return;
      }
      toast.success(`${title} is back at version ${r.version}.`);
      router.refresh();
    });
  return (
    <Modal>
      <Button size="sm" variant="ghost">
        <Undo2 className="size-3.5" aria-hidden />
        Discard
      </Button>
      <Modal.Backdrop>
        <Modal.Container size="sm">
          <Modal.Dialog>
            <Modal.Header>
              <Modal.Heading>Discard version {version}?</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              <p className="text-body text-muted">
                {title} goes back to version {releasedVersion}, the one Ask uses. Version {version} stays in its
                versions, but nothing uses it.
              </p>
            </Modal.Body>
            <Modal.Footer className="flex justify-end gap-2">
              <Button variant="ghost" slot="close">
                Keep the draft
              </Button>
              <Button variant="danger" isPending={pending} onPress={discard} slot="close">
                Discard
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}

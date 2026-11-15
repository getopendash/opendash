"use client";

import { AlertDialog, Button, Input, Label, TextField } from "@heroui/react";
import { useState, useTransition } from "react";
import { deleteSource } from "@/app/(app)/data/sources/actions";

/**
 * Removing a source, confirmed by typing its name. What stops working (datasets, dashboards, routines) isn't
 * listed yet; the answers in threads keep their numbers.
 */
export function DeleteSourceDialog({
  id,
  name,
  sample,
  isOpen,
  onOpenChange,
}: {
  id: string;
  name: string;
  sample: boolean;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const what = sample ? "sample data" : name;
  return (
    <AlertDialog>
      <AlertDialog.Backdrop
        isOpen={isOpen}
        onOpenChange={(open) => {
          if (!open) {
            setTyped("");
            setError(null);
          }
          onOpenChange(open);
        }}
      >
        <AlertDialog.Container>
          <AlertDialog.Dialog>
            <AlertDialog.Header>
              <AlertDialog.Heading>{sample ? "Remove sample data?" : `Delete ${name}?`}</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body className="flex flex-col gap-4">
              <p className="text-body text-muted">
                This removes the connection and what OpenDash learned about it, and deletes the saved password. Answers
                already in threads keep their numbers and sources, but can't ask follow-ups about {what}.
              </p>
              <TextField value={typed} onChange={setTyped} autoFocus>
                <Label>
                  Type <span className="font-mono">{name}</span> to confirm
                </Label>
                <Input autoComplete="off" spellCheck={false} />
              </TextField>
              {error ? <p className="text-small text-danger">{error}</p> : null}
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button variant="ghost" slot="close">
                Cancel
              </Button>
              <Button
                variant="danger"
                isDisabled={typed.trim() !== name}
                isPending={pending}
                onPress={() =>
                  start(async () => {
                    setError(null);
                    // On success the action goes back to Sources; anything returned is why it didn't happen.
                    const result = await deleteSource(id, typed);
                    if (result?.message) setError(result.message);
                  })
                }
              >
                {sample ? "Remove sample data" : "Delete source"}
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </AlertDialog>
  );
}

"use client";

import { Button, FieldError, Input, Label, Modal, TextField } from "@heroui/react";
import { Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { deleteWorkspaceAction } from "@/app/(app)/settings/workspace/actions";
import { PasswordField } from "@/components/auth/password-field";

/**
 * Deleting the workspace (Settings → Workspace, owners): says what goes, then asks for its name typed out and, when
 * the owner's account has a password, the password. Done, the page is loaded afresh: the session's workspace is
 * gone, and the app moves them to another of theirs.
 */
export function DeleteWorkspaceCard({
  name,
  members,
  hasPassword,
}: {
  name: string;
  members: number;
  hasPassword: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [password, setPassword] = useState("");
  const [problem, setProblem] = useState<{ field: "name" | "password" | null; message: string } | null>(null);
  const [pending, setPending] = useState(false);

  const show = () => {
    setTyped("");
    setPassword("");
    setProblem(null);
    setOpen(true);
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setProblem(null);
    const result = await deleteWorkspaceAction({ name: typed, password }).catch(() => ({
      ok: false as const,
      field: null,
      message: "The workspace couldn't be deleted. Check your connection and try again.",
    }));
    if (result.ok) {
      // A full load: nothing cached of the workspace is shown, and the app moves them on.
      window.location.assign("/");
      return;
    }
    setPending(false);
    setProblem({ field: result.field, message: result.message });
  }

  const others = members - 1;
  return (
    <section
      aria-labelledby="delete-workspace-title"
      className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-2xl border border-danger px-5 py-4"
    >
      <Trash2 className="size-5 shrink-0 text-danger" aria-hidden />
      <div className="flex min-w-64 flex-1 flex-col gap-1">
        <h2 id="delete-workspace-title" className="text-body font-medium">
          Delete this workspace
        </h2>
        <p className="text-small text-muted">
          {name} and everything in it goes for good: its sources, knowledge, conversations, dashboards, routines, API
          keys and its Slack connection
          {others > 0 ? `, for you and ${others === 1 ? "its other member" : `its ${others} other members`}` : ""}. Your
          databases aren't touched. Download its data first if you want to keep any of it.
        </p>
      </div>
      <Button size="sm" variant="danger-soft" onPress={show}>
        Delete workspace
      </Button>

      <Modal>
        <Modal.Backdrop isOpen={open} onOpenChange={(isOpen) => (isOpen || pending ? null : setOpen(false))}>
          <Modal.Container size="md">
            <Modal.Dialog>
              <Modal.Header className="flex flex-col gap-1">
                <Modal.Heading>Delete {name}?</Modal.Heading>
                <p className="text-body text-muted">
                  This can't be undone. Nobody can open the workspace a moment later, and nothing brings it back.
                </p>
              </Modal.Header>
              <form onSubmit={submit}>
                <Modal.Body className="flex flex-col gap-3">
                  <TextField
                    value={typed}
                    onChange={(value) => {
                      setTyped(value);
                      setProblem(null);
                    }}
                    isInvalid={problem?.field === "name"}
                    autoFocus
                  >
                    <Label>Type the workspace's name to confirm</Label>
                    <Input placeholder={name} autoComplete="off" required />
                    {problem?.field === "name" ? <FieldError>{problem.message}</FieldError> : null}
                  </TextField>
                  {hasPassword ? (
                    <PasswordField
                      label="Your password"
                      value={password}
                      onChange={(value) => {
                        setPassword(value);
                        setProblem(null);
                      }}
                      error={problem?.field === "password" ? problem.message : null}
                    />
                  ) : null}
                  {problem && problem.field === null ? (
                    <p role="alert" className="text-small text-danger">
                      {problem.message}
                    </p>
                  ) : null}
                </Modal.Body>
                <Modal.Footer className="flex justify-end gap-2">
                  <Button variant="ghost" slot="close" isDisabled={pending}>
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    variant="danger"
                    isPending={pending}
                    isDisabled={typed.trim() !== name.trim() || (hasPassword && !password)}
                  >
                    Delete for good
                  </Button>
                </Modal.Footer>
              </form>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </section>
  );
}

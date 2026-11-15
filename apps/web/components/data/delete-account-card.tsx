"use client";

import { Button, FieldError, Input, Label, Modal, TextField } from "@heroui/react";
import { UserX } from "lucide-react";
import { type FormEvent, useState } from "react";
import { deleteAccountAction } from "@/app/(app)/settings/account/actions";
import { PasswordField } from "@/components/auth/password-field";

export interface AccountPlan {
  /** Workspaces only this person is in: deleted with the account. */
  deleted: string[];
  /** Workspaces they leave. */
  left: string[];
  /** Workspaces others are in that they alone own: the account can't go until that changes. */
  blocking: string[];
}

const list = (names: string[]) =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/**
 * Deleting your own account (Settings → Your data): what happens to each workspace you're in, said before anything
 * does, then your email typed out and, when the account has a password, the password. While you're the only owner
 * of a workspace others are in there's nothing to confirm: it says what to do first.
 */
export function DeleteAccountCard({
  email,
  plan,
  hasPassword,
}: {
  email: string;
  plan: AccountPlan;
  hasPassword: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [password, setPassword] = useState("");
  const [problem, setProblem] = useState<{ field: "email" | "password" | null; message: string } | null>(null);
  const [pending, setPending] = useState(false);
  const blocked = plan.blocking.length > 0;

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
    const result = await deleteAccountAction({ email: typed, password }).catch(() => ({
      ok: false as const,
      field: null,
      message: "Your account couldn't be deleted. Check your connection and try again.",
    }));
    if (result.ok) {
      try {
        sessionStorage.clear();
      } catch {
        // Storage refused (a private window): there's nothing kept to forget.
      }
      // A full load: the session went with the account, and nothing cached for it is shown.
      window.location.assign("/sign-in");
      return;
    }
    setPending(false);
    setProblem({ field: result.field, message: result.message });
  }

  return (
    <section
      aria-labelledby="delete-account-title"
      className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-2xl border border-danger px-5 py-4"
    >
      <UserX className="size-5 shrink-0 text-danger" aria-hidden />
      <div className="flex min-w-64 flex-1 flex-col gap-1">
        <h2 id="delete-account-title" className="text-body font-medium">
          Delete your account
        </h2>
        <p className="text-small text-muted">
          Your sign-in, sessions, API keys and memberships go for good, in every workspace.
          {plan.deleted.length
            ? ` ${list(plan.deleted)} ${plan.deleted.length === 1 ? "has" : "have"} no other member, and ${plan.deleted.length === 1 ? "is" : "are"} deleted with it.`
            : ""}
          {plan.left.length
            ? ` In ${list(plan.left)}, your private conversations and dashboards are deleted; what you shared stays, with no name on it.`
            : ""}
        </p>
        {blocked ? (
          <p className="text-small text-danger">
            You're the only owner of {list(plan.blocking)}. Make someone else an owner there, or delete{" "}
            {plan.blocking.length === 1 ? "it" : "them"}, before deleting your account.
          </p>
        ) : null}
      </div>
      <Button size="sm" variant="danger-soft" onPress={show} isDisabled={blocked}>
        Delete account
      </Button>

      <Modal>
        <Modal.Backdrop isOpen={open} onOpenChange={(isOpen) => (isOpen || pending ? null : setOpen(false))}>
          <Modal.Container size="md">
            <Modal.Dialog>
              <Modal.Header className="flex flex-col gap-1">
                <Modal.Heading>Delete your account?</Modal.Heading>
                <p className="text-body text-muted">
                  This can't be undone. You're signed out everywhere, and nothing brings the account back.
                </p>
              </Modal.Header>
              <form onSubmit={submit}>
                <Modal.Body className="flex flex-col gap-3">
                  <TextField
                    type="email"
                    value={typed}
                    onChange={(value) => {
                      setTyped(value);
                      setProblem(null);
                    }}
                    isInvalid={problem?.field === "email"}
                    autoFocus
                  >
                    <Label>Type your email to confirm</Label>
                    <Input placeholder={email} autoComplete="off" required />
                    {problem?.field === "email" ? <FieldError>{problem.message}</FieldError> : null}
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
                    isDisabled={typed.trim().toLowerCase() !== email.toLowerCase() || (hasPassword && !password)}
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

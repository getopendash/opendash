"use client";

import { Button, Description, Label, ListBox, Modal, Select, Tag, TagGroup, toast } from "@heroui/react";
import { CircleAlert, Send } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ClipboardEvent, type KeyboardEvent, useState, useTransition } from "react";
import { invitePeople } from "@/app/(app)/settings/members/actions";
import { ROLE_INFO, type Role } from "@/lib/roles";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const split = (text: string) =>
  text
    .split(/[\s,;]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

/** Invite people by email, one role for the batch. Each address is checked on its own before anything is sent. */
export function InviteDialog({
  org,
  roles,
  members,
  invited,
  isOpen,
  onOpenChange,
}: {
  org: string;
  /** The roles this person may hand out, owner excluded. */
  roles: Role[];
  /** Emails already in the organization, and already invited. */
  members: string[];
  invited: string[];
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [emails, setEmails] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const problem = (email: string) =>
    !EMAIL.test(email)
      ? `${email} isn't an email address.`
      : members.includes(email)
        ? `${email} is already in ${org}.`
        : invited.includes(email)
          ? `${email} already has an invitation; resend it from the list.`
          : null;
  const add = (text: string) => {
    const next = split(text).filter((e) => !emails.includes(e));
    if (next.length) setEmails([...emails, ...next]);
    setDraft("");
  };
  const valid = emails.filter((e) => !problem(e));
  const problems = emails.map(problem).filter(Boolean);
  const reset = () => {
    setEmails([]);
    setDraft("");
    setError(null);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if ((e.key === "Enter" || e.key === "," || e.key === " ") && draft.trim()) {
      e.preventDefault();
      add(draft);
    } else if (e.key === "Backspace" && !draft && emails.length) {
      setEmails(emails.slice(0, -1));
    }
  };
  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    add(`${draft} ${e.clipboardData.getData("text")}`);
  };

  return (
    <Modal>
      <Modal.Backdrop
        isOpen={isOpen}
        onOpenChange={(open) => {
          if (!open) reset();
          onOpenChange(open);
        }}
      >
        <Modal.Container size="md">
          <Modal.Dialog>
            <Modal.Header className="flex flex-col gap-1">
              <Modal.Heading>Invite people to {org}</Modal.Heading>
              <p className="text-body text-muted">
                Each person gets an email with a link to join. The link works once and expires in 7 days.
              </p>
            </Modal.Header>
            <Modal.Body className="flex flex-col gap-5">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="invite-emails" className="text-body font-medium">
                  Email addresses
                </label>
                <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-border bg-surface px-2 py-1.5 focus-within:border-accent">
                  {emails.length ? (
                    <TagGroup
                      aria-label="Emails to invite"
                      size="sm"
                      onRemove={(keys) => setEmails(emails.filter((e) => !keys.has(e)))}
                    >
                      <TagGroup.List className="flex flex-wrap gap-1.5">
                        {emails.map((email) => (
                          <Tag
                            key={email}
                            id={email}
                            textValue={email}
                            className={problem(email) ? "bg-danger-soft text-danger" : undefined}
                          >
                            {email}
                          </Tag>
                        ))}
                      </TagGroup.List>
                    </TagGroup>
                  ) : null}
                  <input
                    id="invite-emails"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={onKeyDown}
                    onPaste={onPaste}
                    onBlur={() => draft.trim() && add(draft)}
                    placeholder={emails.length ? "Add more…" : "name@company.com"}
                    autoComplete="off"
                    spellCheck={false}
                    className="min-w-40 flex-1 bg-transparent px-1 py-1 text-body outline-none placeholder:text-muted-tertiary"
                  />
                </div>
                {problems.map((p) => (
                  <p key={p} className="flex items-center gap-1.5 text-small text-danger">
                    <CircleAlert className="size-3.5 shrink-0" aria-hidden />
                    {p}
                  </p>
                ))}
                <span className="text-small text-muted-tertiary">
                  Separate addresses with commas or spaces, or paste a list.
                </span>
              </div>
              <Select
                selectedKey={role}
                onSelectionChange={(k) => setRole(String(k) as Role)}
                className="flex flex-col gap-1.5"
              >
                <Label>Role</Label>
                <Select.Trigger>
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover>
                  <ListBox>
                    {roles.map((r) => (
                      <ListBox.Item key={r} id={r} textValue={ROLE_INFO[r].label}>
                        <span className="flex flex-col gap-0.5">
                          <Label>{ROLE_INFO[r].label}</Label>
                          <Description>{ROLE_INFO[r].description}</Description>
                        </span>
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                    ))}
                  </ListBox>
                </Select.Popover>
                <span className="text-small text-muted-tertiary">
                  {ROLE_INFO[role].description} You can change it later.
                </span>
              </Select>
              {error ? <p className="text-small text-danger">{error}</p> : null}
            </Modal.Body>
            <Modal.Footer className="flex justify-end gap-2">
              <Button variant="ghost" slot="close">
                Cancel
              </Button>
              <Button
                isPending={pending}
                isDisabled={!valid.length}
                onPress={() =>
                  start(async () => {
                    setError(null);
                    const r = await invitePeople(valid, role);
                    if ("message" in r) {
                      setError(r.message);
                      return;
                    }
                    if (r.sent.length) {
                      toast.success(`${r.sent.length} ${r.sent.length === 1 ? "invitation" : "invitations"} sent.`);
                    }
                    router.refresh();
                    if (r.problems.length) {
                      setEmails(emails.filter((e) => !r.sent.includes(e)));
                      setError(r.problems.join(" "));
                    } else {
                      reset();
                      onOpenChange(false);
                    }
                  })
                }
              >
                <Send className="size-3.5" aria-hidden />
                {valid.length > 1 ? `Send ${valid.length} invitations` : "Send invitation"}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}

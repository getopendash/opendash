"use client";

import { Alert, Button, Chip, Label, ListBox, Modal, Select, toast } from "@heroui/react";
import { AUDIT_ACTIONS, isAuditAction } from "@opendash/core/audit";
import type { ScimRole, ScimStatus } from "@opendash/core/enterprise";
import { CodeBlock } from "@opendash/ui";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  connectDirectory,
  disconnectDirectory,
  mapDirectoryGroup,
  newDirectoryToken,
} from "@/app/(app)/settings/directory-sync/actions";
import { ago, count, shortDate } from "@/lib/format";

/** With the year: a token lasts one. */
const longDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" });

const ROLE_OPTIONS: { id: ScimRole | "none"; label: string }[] = [
  { id: "none", label: "No role" },
  { id: "viewer", label: "Viewer" },
  { id: "member", label: "Member" },
  { id: "admin", label: "Admin" },
];

/** A change the directory made, in a line: "Priya Shah joined as viewer". */
function changeLine(r: ScimStatus["recent"][number]): string {
  const who = r.target ?? "Someone";
  const role = typeof r.detail.role === "string" ? r.detail.role : "";
  switch (r.action) {
    case "member.joined":
      return `${who} joined as ${role || "viewer"}`;
    case "member.role_changed":
      return `${who} is ${String(r.detail.to)}, was ${String(r.detail.from)}`;
    case "member.removed":
      return `${who} was removed`;
    case "scim.refused":
      return `${who} wasn't added: not at a verified domain`;
    case "scim.owner_kept":
      return `${who} was kept: the workspace's last owner`;
    case "scim.mapping_updated":
      return `${who} ${role === "none" ? "gives no role" : `gives ${role}`}`;
    default:
      return isAuditAction(r.action) ? AUDIT_ACTIONS[r.action].label : r.action;
  }
}

/**
 * Directory sync: the connection and its token, the groups and the roles they give, and the directory's latest changes.
 * A token is shown once. Without a license: read-only, except a new token and Disconnect.
 */
export function DirectorySync({ status, licensed }: { status: ScimStatus; licensed: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [shown, setShown] = useState<{ token: string; expiresAt: string; fresh: boolean } | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);
  const noDomain = !status.domains.length;

  const issue = (fresh: boolean) =>
    start(async () => {
      const r = fresh ? await connectDirectory() : await newDirectoryToken();
      if (!r.ok) {
        toast.danger(r.message);
        return;
      }
      setShown({ ...r.value, fresh });
      router.refresh();
    });

  return (
    <div className="flex flex-col gap-5">
      {!licensed && status.connected ? (
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>Still syncing</Alert.Title>
            <Alert.Description>
              Your directory keeps adding and removing people. Connecting one again and mapping groups need an
              Enterprise license; a new token and Disconnect still work.
            </Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
      {noDomain ? (
        <Alert status="accent">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>Verify your domain first</Alert.Title>
            <Alert.Description>
              Only people at a domain you've verified are added, so a directory can't claim strangers.{" "}
              <Link href="/settings/single-sign-on" className="text-link">
                Verify it in Single sign-on
              </Link>
              .
            </Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}

      {status.connected && status.token ? (
        <section className="flex flex-col gap-3 rounded-2xl border border-border px-5 py-4">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-body font-semibold">Directory</h2>
            <Chip size="sm" color="success" variant="soft">
              Connected
            </Chip>
            <span className="flex-1" />
            <Button size="sm" variant="outline" isPending={pending} onPress={() => issue(false)}>
              New token
            </Button>
            <Button size="sm" variant="ghost" onPress={() => setConfirmOff(true)}>
              Disconnect
            </Button>
          </div>
          <dl className="flex flex-col gap-2 text-body">
            <div className="flex flex-wrap gap-x-6 gap-y-1">
              <dt className="w-28 shrink-0 text-muted">Base URL</dt>
              <dd className="min-w-0 break-all font-mono text-small">{status.baseUrl}</dd>
            </div>
            <div className="flex flex-wrap gap-x-6 gap-y-1">
              <dt className="w-28 shrink-0 text-muted">Token</dt>
              <dd className="min-w-0">
                made {shortDate(status.token.createdAt)}, expires {longDate(status.token.expiresAt)}
                {status.token.lastUsedAt
                  ? ` · last used ${ago(status.token.lastUsedAt, Date.now())}`
                  : " · not used yet"}
              </dd>
            </div>
            <div className="flex flex-wrap gap-x-6 gap-y-1">
              <dt className="w-28 shrink-0 text-muted">People</dt>
              <dd className="min-w-0">{count(status.people, "person", "people")} added and active</dd>
            </div>
          </dl>
        </section>
      ) : (
        <section className="flex flex-wrap items-center gap-3 rounded-2xl border border-border px-5 py-4">
          <div className="flex min-w-56 flex-1 flex-col gap-0.5">
            <h2 className="text-body font-semibold">No directory connected</h2>
            <span className="text-small text-muted">
              You'll get a URL and a token to paste into your identity provider's SCIM settings.
            </span>
          </div>
          <Button isDisabled={noDomain || !licensed} isPending={pending} onPress={() => issue(true)}>
            Connect a directory
          </Button>
        </section>
      )}

      <section className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="text-body font-semibold">Groups and roles</h2>
          <span className="text-small text-muted">
            The highest role a person's groups give. Owner is only ever given by hand.
          </span>
        </div>
        <div className="overflow-x-auto rounded-2xl border border-border">
          <table className="w-full text-small">
            <thead className="bg-surface-secondary text-muted-tertiary">
              <tr>
                <th className="px-4 py-2 text-start font-medium">Group in your directory</th>
                <th className="px-4 py-2 text-end font-medium">People</th>
                <th className="px-4 py-2 text-start font-medium">Role here</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {status.groups.map((g) => (
                <tr key={g.groupId}>
                  <td className="px-4 py-2 text-body">{g.name}</td>
                  <td className="px-4 py-2 text-end text-body tabular-nums">{g.members}</td>
                  <td className="px-4 py-2">
                    <Select
                      aria-label={`Role for ${g.name}`}
                      className="w-36"
                      selectedKey={g.role ?? "none"}
                      isDisabled={!licensed || pending}
                      onSelectionChange={(key) =>
                        start(async () => {
                          const role = String(key) === "none" ? null : (String(key) as ScimRole);
                          const r = await mapDirectoryGroup(g.groupId, role);
                          if (!r.ok) toast.danger(r.message);
                          else
                            toast.success(
                              `${g.name} ${role ? `gives ${role}` : "gives no role"}. Its people have it now.`,
                            );
                          router.refresh();
                        })
                      }
                    >
                      <Select.Trigger>
                        <Select.Value />
                        <Select.Indicator />
                      </Select.Trigger>
                      <Select.Popover>
                        <ListBox>
                          {ROLE_OPTIONS.map((o) => (
                            <ListBox.Item key={o.id} id={o.id} textValue={o.label}>
                              <Label>{o.label}</Label>
                              <ListBox.ItemIndicator />
                            </ListBox.Item>
                          ))}
                        </ListBox>
                      </Select.Popover>
                    </Select>
                  </td>
                </tr>
              ))}
              <tr>
                <td className="px-4 py-2 text-muted" colSpan={2}>
                  {status.groups.length
                    ? "Someone it adds in no mapped group"
                    : "Groups appear here once your directory pushes them"}
                </td>
                <td className="px-4 py-2">
                  <Chip size="sm" variant="soft">
                    Viewer
                  </Chip>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="text-small text-muted">
          It changes only roles it gave: a role you set by hand stays until a mapped group says otherwise.
        </p>
      </section>

      {status.recent.length ? (
        <section className="flex flex-col gap-2.5">
          <h2 className="text-body font-semibold">Latest changes</h2>
          <ul className="flex flex-col divide-y divide-border rounded-2xl border border-border">
            {status.recent.map((r) => (
              <li key={`${r.at}-${r.action}-${r.target}`} className="flex items-center gap-3 px-4 py-2 text-body">
                <span className="min-w-0 flex-1">{changeLine(r)}</span>
                <span className="shrink-0 text-small text-muted-tertiary">{ago(r.at, Date.now())}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {shown ? (
        <Modal>
          <Modal.Backdrop isOpen onOpenChange={(open) => (open ? null : setShown(null))}>
            <Modal.Container size="md">
              <Modal.Dialog>
                <Modal.Header className="flex flex-col gap-1">
                  <Modal.Heading>{shown.fresh ? "Connect a directory" : "A new token"}</Modal.Heading>
                  <p className="text-body text-muted">Copy the token now. It isn't shown again.</p>
                </Modal.Header>
                <Modal.Body className="flex flex-col gap-4">
                  <div className="flex flex-col gap-1">
                    <span className="text-small font-medium text-muted">SCIM base URL</span>
                    <CodeBlock code={status.baseUrl} wrap label="Copy the base URL" />
                  </div>
                  <div className="flex flex-col gap-1">
                    <span className="text-small font-medium text-muted">Token</span>
                    <CodeBlock code={shown.token} wrap label="Copy the token" />
                    <span className="text-small text-muted-tertiary">
                      Expires {longDate(shown.expiresAt)}.{shown.fresh ? "" : " The old token stopped working."}
                    </span>
                  </div>
                </Modal.Body>
                <Modal.Footer className="flex justify-end">
                  <Button onPress={() => setShown(null)}>I've copied it</Button>
                </Modal.Footer>
              </Modal.Dialog>
            </Modal.Container>
          </Modal.Backdrop>
        </Modal>
      ) : null}

      {confirmOff ? (
        <Modal>
          <Modal.Backdrop isOpen onOpenChange={(open) => (open ? null : setConfirmOff(false))}>
            <Modal.Container size="md">
              <Modal.Dialog>
                <Modal.Header>
                  <Modal.Heading>Disconnect the directory?</Modal.Heading>
                </Modal.Header>
                <Modal.Body className="flex flex-col gap-2 text-body">
                  <p>Its token stops working, so nobody is added or removed until you connect again.</p>
                  <p className="text-small text-muted">
                    People it already added stay, with their roles. Connecting again picks up where it left off.
                  </p>
                </Modal.Body>
                <Modal.Footer className="flex justify-end gap-2">
                  <Button variant="ghost" onPress={() => setConfirmOff(false)}>
                    Cancel
                  </Button>
                  <Button
                    variant="danger"
                    isPending={pending}
                    onPress={() =>
                      start(async () => {
                        const r = await disconnectDirectory();
                        if (!r.ok) toast.danger(r.message);
                        else toast.success("Disconnected. Nobody is added or removed until you connect again.");
                        setConfirmOff(false);
                        router.refresh();
                      })
                    }
                  >
                    Disconnect
                  </Button>
                </Modal.Footer>
              </Modal.Dialog>
            </Modal.Container>
          </Modal.Backdrop>
        </Modal>
      ) : null}
    </div>
  );
}

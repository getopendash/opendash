"use client";

import {
  Alert,
  Button,
  Chip,
  Dropdown,
  Input,
  Label,
  ListBox,
  Modal,
  Select,
  Switch,
  TextArea,
  TextField,
  toast,
} from "@heroui/react";
import type { SsoJoinRole, SsoProviderView } from "@opendash/core/enterprise";
import { EllipsisVertical, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  activateProvider,
  changeProvider,
  disableProvider,
  enableProvider,
  removeProvider,
  replaceSecret,
  requireProvider,
  setJoinRole,
  stopRequiring,
} from "@/app/(app)/settings/single-sign-on/actions";
import { ago, count } from "@/lib/format";
import { AddProviderDialog } from "./add-provider-dialog";
import { startSsoSignIn } from "./start-sign-in";

const STATUS: Record<
  SsoProviderView["status"],
  { label: string; color: "default" | "warning" | "success" | "danger" }
> = {
  draft: { label: "Draft", color: "default" },
  verified: { label: "Not tested", color: "warning" },
  active: { label: "Active", color: "success" },
  disabled: { label: "Disabled", color: "danger" },
};

/** What someone new to the workspace joins as at their first sign-in: never admin (that's by hand or a group). */
const JOIN_ROLES: { id: SsoJoinRole; label: string }[] = [
  { id: "viewer", label: "Viewer" },
  { id: "member", label: "Member" },
];

/** Why a test sign-in came back without signing in, as the plugin and our hooks say it. */
const TEST_ERRORS: Record<string, string> = {
  SSO_DOMAIN_MISMATCH: "the identity provider signed in someone outside the provider's domain",
  SSO_UNAVAILABLE: "the provider can't sign anyone in yet",
  invalid_state: "the sign-in took too long or was started in another browser",
  discovery_failed: "OpenDash couldn't read the provider's OIDC discovery document",
  invalid_provider: "the identity provider's answer couldn't be checked",
};

type Dialog =
  | { kind: "add" }
  | { kind: "resume"; provider: SsoProviderView }
  | { kind: "require"; provider: SsoProviderView }
  | { kind: "disable"; provider: SsoProviderView }
  | { kind: "remove"; provider: SsoProviderView }
  | { kind: "edit"; provider: SsoProviderView }
  | { kind: "secret"; provider: SsoProviderView }
  | null;

/**
 * Settings → Single sign-on: the providers, each with its next step, Require, Disable and the rest in its menu; what to
 * give the identity provider. Without a license it's read-only except Disable, the way back in.
 */
export function SsoSettings({
  providers,
  licensed,
  origin,
  maxAuthAgeHours,
  session,
  tested,
  testFailed,
}: {
  providers: SsoProviderView[];
  licensed: boolean;
  origin: string;
  maxAuthAgeHours: number;
  /** Where this session came from: a provider whose test sign-in it proves. */
  session: { providerId: string | null; at: string | null };
  /** Back from a test sign-in: the provider, or the provider and why it failed. */
  tested: string | null;
  testFailed: { providerId: string; error: string | null } | null;
}) {
  const router = useRouter();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [pending, start] = useTransition();
  const close = () => setDialog(null);

  const proven = (p: SsoProviderView) =>
    session.providerId === p.providerId && session.at !== null && new Date(session.at) > new Date(p.updatedAt);
  const run = (work: () => Promise<{ ok: boolean; message?: string }>, done: string) =>
    start(async () => {
      const r = await work();
      if (!r.ok) toast.danger(r.message ?? "That didn't work.");
      else toast.success(done);
      router.refresh();
    });
  const test = (p: SsoProviderView) =>
    start(async () => {
      const r = await startSsoSignIn({ providerId: p.providerId, test: true });
      if (r) toast.danger(r.message);
    });
  const failed = testFailed ? providers.find((p) => p.providerId === testFailed.providerId) : null;
  const passed = tested ? providers.find((p) => p.providerId === tested && proven(p) && p.status === "verified") : null;

  return (
    <div className="flex flex-col gap-5">
      {!licensed ? (
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>Read-only without a license</Alert.Title>
            <Alert.Description>
              Your providers keep signing people in and requiring them stays as it is. Adding or changing them needs an
              Enterprise license; Disable still works, so you can always get back in.
            </Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
      {passed ? (
        <Alert status="success">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>The test sign-in through {passed.name} worked</Alert.Title>
            <Alert.Description>Activate it so it can be required for {passed.domain}.</Alert.Description>
          </Alert.Content>
          <Button
            size="sm"
            isPending={pending}
            onPress={() => run(() => activateProvider(passed.providerId), `${passed.name} is active.`)}
          >
            Activate
          </Button>
        </Alert>
      ) : null}
      {failed ? (
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>The test sign-in through {failed.name} didn't finish</Alert.Title>
            <Alert.Description>
              {testFailed?.error && TEST_ERRORS[testFailed.error]
                ? `${TEST_ERRORS[testFailed.error]}.`
                : "Check the settings in your identity provider and try again."}
            </Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}

      {licensed ? (
        <div className="flex justify-end">
          <Button onPress={() => setDialog({ kind: "add" })}>
            <Plus className="size-4" aria-hidden />
            Add provider
          </Button>
        </div>
      ) : null}

      {providers.length ? (
        <div className="overflow-x-auto rounded-2xl border border-border">
          <table className="w-full text-small">
            <thead className="bg-surface-secondary text-muted-tertiary">
              <tr>
                <th className="px-4 py-2 text-start font-medium">Provider</th>
                <th className="hidden px-4 py-2 text-start font-medium @2xl/page:table-cell">Domain</th>
                <th className="px-4 py-2 text-start font-medium">Status</th>
                <th className="px-4 py-2 text-start font-medium">Required</th>
                <th className="hidden px-4 py-2 text-end font-medium @2xl/page:table-cell">Sessions</th>
                <th className="px-4 py-2">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {providers.map((p) => (
                <tr key={p.providerId} className="align-middle">
                  <td className="px-4 py-2.5">
                    <span className="block text-body font-medium">{p.name}</span>
                    <span className="block whitespace-nowrap text-muted-tertiary">
                      {p.protocol === "saml" ? "SAML 2.0" : "OIDC"} · <span className="font-mono">{p.providerId}</span>
                    </span>
                    <span className="block whitespace-nowrap text-muted-tertiary @2xl/page:hidden">{p.domain}</span>
                    {/* In the provider's own cell, not a column: it takes no width, so the row's actions still fit. */}
                    <Select
                      className="mt-2 w-fit"
                      selectedKey={p.joinRole}
                      isDisabled={!licensed || pending}
                      onSelectionChange={(key) => {
                        const role = String(key) as SsoJoinRole;
                        if (role === p.joinRole) return;
                        run(
                          () => setJoinRole(p.providerId, role),
                          `People new to the workspace who sign in through ${p.name} join as ${role === "member" ? "members" : "viewers"}.`,
                        );
                      }}
                    >
                      <Label className="whitespace-nowrap text-small text-muted">New people join as</Label>
                      <Select.Trigger className="w-28">
                        <Select.Value />
                        <Select.Indicator />
                      </Select.Trigger>
                      <Select.Popover>
                        <ListBox>
                          {JOIN_ROLES.map((o) => (
                            <ListBox.Item key={o.id} id={o.id} textValue={o.label}>
                              <Label>{o.label}</Label>
                              <ListBox.ItemIndicator />
                            </ListBox.Item>
                          ))}
                        </ListBox>
                      </Select.Popover>
                    </Select>
                  </td>
                  <td className="hidden px-4 py-2.5 @2xl/page:table-cell">
                    <span className="block text-body">{p.domain}</span>
                    <span className="block text-muted-tertiary">
                      {p.domainVerified ? "verified by DNS" : "not verified"}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    <Chip size="sm" variant="soft" color={STATUS[p.status].color} className="whitespace-nowrap">
                      {STATUS[p.status].label}
                    </Chip>
                    {p.lastTestedAt && p.status === "active" ? (
                      <span className="mt-0.5 block whitespace-nowrap text-muted-tertiary">
                        tested {ago(p.lastTestedAt, Date.now())}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-2.5">
                    <Switch
                      size="sm"
                      isSelected={p.enforced}
                      isDisabled={!licensed || p.status !== "active" || pending}
                      aria-label={`Require ${p.name} for ${p.domain}`}
                      onChange={(on) =>
                        on
                          ? setDialog({ kind: "require", provider: p })
                          : run(() => stopRequiring(p.providerId), `${p.name} is optional again for ${p.domain}.`)
                      }
                    >
                      <Switch.Content>
                        <Switch.Control>
                          <Switch.Thumb />
                        </Switch.Control>
                        <span className="whitespace-nowrap text-small text-muted">
                          {p.enforced ? "Required" : p.status === "active" ? "Optional" : "Not yet"}
                        </span>
                      </Switch.Content>
                    </Switch>
                  </td>
                  <td className="hidden px-4 py-2.5 text-end text-body tabular-nums @2xl/page:table-cell">
                    {p.status === "disabled" ? "—" : p.sessions}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center justify-end gap-1.5">
                      {p.status === "disabled" ? (
                        licensed ? (
                          <Button
                            size="sm"
                            variant="outline"
                            isPending={pending}
                            onPress={() =>
                              run(
                                () => enableProvider(p.providerId),
                                `${p.name} is enabled. Test it again to make it active.`,
                              )
                            }
                          >
                            Enable
                          </Button>
                        ) : null
                      ) : p.status === "draft" && licensed ? (
                        <Button size="sm" variant="outline" onPress={() => setDialog({ kind: "resume", provider: p })}>
                          Verify domain
                        </Button>
                      ) : p.status === "verified" && licensed ? (
                        proven(p) ? (
                          <Button
                            size="sm"
                            isPending={pending}
                            onPress={() => run(() => activateProvider(p.providerId), `${p.name} is active.`)}
                          >
                            Activate
                          </Button>
                        ) : (
                          <Button size="sm" variant="outline" isPending={pending} onPress={() => test(p)}>
                            Test sign-in
                          </Button>
                        )
                      ) : null}
                      {p.status !== "disabled" ? (
                        <Button size="sm" variant="ghost" onPress={() => setDialog({ kind: "disable", provider: p })}>
                          Disable
                        </Button>
                      ) : null}
                      {licensed ? (
                        <Dropdown>
                          <Button size="sm" variant="ghost" isIconOnly aria-label={`More for ${p.name}`}>
                            <EllipsisVertical className="size-4" aria-hidden />
                          </Button>
                          <Dropdown.Popover placement="bottom end" className="min-w-52">
                            <Dropdown.Menu
                              onAction={(key) => {
                                if (key === "test") test(p);
                                else if (key === "edit") setDialog({ kind: "edit", provider: p });
                                else if (key === "secret") setDialog({ kind: "secret", provider: p });
                                else if (key === "remove") setDialog({ kind: "remove", provider: p });
                              }}
                              disabledKeys={p.enforced ? ["edit", "remove"] : []}
                            >
                              {p.domainVerified && p.status !== "disabled" ? (
                                <Dropdown.Item id="test" textValue="Test sign-in">
                                  <Label>Test sign-in</Label>
                                </Dropdown.Item>
                              ) : null}
                              <Dropdown.Item id="edit" textValue="Edit settings">
                                <Label>Edit settings</Label>
                              </Dropdown.Item>
                              {p.protocol === "oidc" ? (
                                <Dropdown.Item id="secret" textValue="Replace client secret">
                                  <Label>Replace client secret</Label>
                                </Dropdown.Item>
                              ) : null}
                              <Dropdown.Item id="remove" textValue="Remove" variant="danger">
                                <Label>Remove</Label>
                              </Dropdown.Item>
                            </Dropdown.Menu>
                          </Dropdown.Popover>
                        </Dropdown>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="border-t border-border px-4 py-2 text-small text-muted">
            New people join with this role the first time they sign in. An invitation's role wins, and nobody already in
            the workspace changes. Make admins by hand, or map a group in Directory sync.
          </p>
        </div>
      ) : (
        <section className="flex flex-col gap-1 rounded-2xl border border-dashed border-border px-5 py-6 text-center">
          <h2 className="text-body font-medium">No identity provider yet</h2>
          <p className="text-body text-muted">Add Okta, Entra ID, Google Workspace or any OIDC or SAML 2.0 provider.</p>
        </section>
      )}

      <section className="flex flex-col gap-2.5 rounded-2xl border border-border px-5 py-4">
        <h2 className="text-body font-semibold">For your identity provider</h2>
        <dl className="flex flex-col gap-2 text-body">
          <div className="flex flex-wrap gap-x-6 gap-y-1">
            <dt className="w-36 shrink-0 text-muted">Instance address</dt>
            <dd className="min-w-0 break-all font-mono text-small">{origin}</dd>
          </div>
          <div className="flex flex-wrap gap-x-6 gap-y-1">
            <dt className="w-36 shrink-0 text-muted">Session length</dt>
            <dd className="min-w-0">
              People at a required domain sign in through it again after {count(maxAuthAgeHours, "hour")}.
            </dd>
          </div>
        </dl>
        <p className="text-small text-muted">
          The addresses your identity provider calls are built from this one. Changing it breaks every provider set up
          against it.
        </p>
      </section>

      <AddProviderDialog
        origin={origin}
        isOpen={dialog?.kind === "add" || dialog?.kind === "resume"}
        onOpenChange={(open) => (open ? null : close())}
        resume={dialog?.kind === "resume" ? dialog.provider : null}
      />
      {dialog?.kind === "require" ? <RequireDialog provider={dialog.provider} onClose={close} /> : null}
      {dialog?.kind === "disable" ? (
        <DisableDialog
          provider={dialog.provider}
          mine={session.providerId === dialog.provider.providerId}
          onClose={close}
        />
      ) : null}
      {dialog?.kind === "remove" ? (
        <RemoveDialog
          provider={dialog.provider}
          mine={session.providerId === dialog.provider.providerId}
          onClose={close}
        />
      ) : null}
      {dialog?.kind === "edit" ? <EditDialog provider={dialog.provider} onClose={close} /> : null}
      {dialog?.kind === "secret" ? <SecretDialog provider={dialog.provider} onClose={close} /> : null}
    </div>
  );
}

/** A confirmation dialog: open while mounted, closing calls onClose. */
function Confirm({
  title,
  children,
  action,
  danger,
  disabled,
  onConfirm,
  onClose,
  pending,
}: {
  title: string;
  children: React.ReactNode;
  action: string;
  danger?: boolean;
  disabled?: boolean;
  onConfirm: () => void;
  onClose: () => void;
  pending: boolean;
}) {
  return (
    <Modal>
      <Modal.Backdrop isOpen onOpenChange={(open) => (open ? null : onClose())}>
        <Modal.Container size="md">
          <Modal.Dialog>
            <Modal.Header>
              <Modal.Heading>{title}</Modal.Heading>
            </Modal.Header>
            <Modal.Body className="flex flex-col gap-3 text-body">{children}</Modal.Body>
            <Modal.Footer className="flex justify-end gap-2">
              <Button variant="ghost" onPress={onClose}>
                Cancel
              </Button>
              <Button
                variant={danger ? "danger" : "primary"}
                isPending={pending}
                isDisabled={disabled}
                onPress={onConfirm}
              >
                {action}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}

/** Requiring it ends what didn't come through it, across the instance, so the dialog says how much. */
function RequireDialog({ provider: p, onClose }: { provider: SsoProviderView; onClose: () => void }) {
  const router = useRouter();
  const [typed, setTyped] = useState("");
  const [pending, start] = useTransition();
  return (
    <Confirm
      title={`Require ${p.name} for everyone at ${p.domain}?`}
      action={`Require ${p.name}`}
      pending={pending}
      disabled={typed.trim().toLowerCase() !== p.domain}
      onClose={onClose}
      onConfirm={() =>
        start(async () => {
          const r = await requireProvider(p.providerId, typed);
          if (!r.ok) {
            toast.danger(r.message);
            return;
          }
          toast.success(
            `${p.name} is now required for ${p.domain}. ${count(r.value.sessionsEnded, "other session")} ended and ${count(r.value.keysRevoked, "API key")} revoked.`,
          );
          onClose();
          router.refresh();
        })
      }
    >
      <p>
        This ends <strong>{count(p.otherSessions, "session")}</strong> that didn't come through {p.name} and revokes{" "}
        <strong>{count(p.keysAtDomain, "API key")}</strong> held or made by people at {p.domain}, in every workspace on
        this instance. They sign in again through {p.name}. Password and email-link sign-in stop for them.
      </p>
      <p className="text-small text-muted">
        Members at other domains keep their own ways in. If {p.name} fails, Disable lets everyone back in by email.
      </p>
      <TextField value={typed} onChange={setTyped} autoFocus>
        <Label>Type {p.domain} to confirm</Label>
        <Input autoComplete="off" spellCheck={false} />
      </TextField>
    </Confirm>
  );
}

/** Disabling a provider: the way back in. */
function DisableDialog({
  provider: p,
  mine,
  onClose,
}: {
  provider: SsoProviderView;
  mine: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Confirm
      title={`Disable ${p.name}?`}
      action="Disable"
      danger
      pending={pending}
      onClose={onClose}
      onConfirm={() =>
        start(async () => {
          const r = await disableProvider(p.providerId);
          if (!r.ok) {
            toast.danger(r.message);
            return;
          }
          toast.success(
            `${p.name} is disabled.${p.enforced ? ` People at ${p.domain} can sign in with email again.` : ""}`,
          );
          onClose();
          router.refresh();
        })
      }
    >
      <p>
        Its {count(p.sessions, "session")} end and nobody can sign in through it.
        {p.enforced ? ` Requiring it is lifted, so people at ${p.domain} can sign in with email again.` : ""}
      </p>
      {mine ? <YoursEnds /> : null}
      <p className="text-small text-muted">
        Its settings and the domain proof are kept, so Enable needs neither again. From the server:{" "}
        <code>pnpm sso:disable --provider {p.providerId}</code>.
      </p>
    </Confirm>
  );
}

function RemoveDialog({
  provider: p,
  mine,
  onClose,
}: {
  provider: SsoProviderView;
  mine: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Confirm
      title={`Remove ${p.name}?`}
      action="Remove"
      danger
      pending={pending}
      onClose={onClose}
      onConfirm={() =>
        start(async () => {
          const r = await removeProvider(p.providerId);
          if (!r.ok) {
            toast.danger(r.message);
            return;
          }
          toast.success(`${p.name} is removed.`);
          onClose();
          router.refresh();
        })
      }
    >
      <p>
        Its {count(p.sessions, "session")} end, and the people who signed in through it keep their accounts but not this
        way in. Adding it again needs the DNS record and a test sign-in again.
      </p>
      {mine ? <YoursEnds /> : null}
    </Confirm>
  );
}

/** This browser's session came through the provider, so ending its sessions signs it out. */
function YoursEnds() {
  return (
    <p className="rounded-xl bg-warning-soft px-3 py-2 text-small text-warning-soft-foreground">
      That includes yours: you signed in through it, so you'll be signed out and can sign in again by email.
    </p>
  );
}

/** The settings a provider was added with. Its identity can't change once someone signed in through it. */
function EditDialog({ provider: p, onClose }: { provider: SsoProviderView; onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = useState(p.name);
  const [domain, setDomain] = useState(p.domain);
  const [issuer, setIssuer] = useState("");
  const [clientId, setClientId] = useState("");
  const [metadata, setMetadata] = useState("");
  const [pending, start] = useTransition();
  const metadataIsUrl = /^https:\/\//.test(metadata.trim());
  return (
    <Confirm
      title={`Edit ${p.name}`}
      action="Save"
      pending={pending}
      onClose={onClose}
      onConfirm={() =>
        start(async () => {
          const r = await changeProvider(p.providerId, {
            ...(name !== p.name ? { name } : {}),
            ...(domain !== p.domain ? { domain } : {}),
            ...(issuer ? { issuer } : {}),
            ...(clientId ? { clientId } : {}),
            ...(metadata ? (metadataIsUrl ? { metadataUrl: metadata.trim() } : { metadataXml: metadata }) : {}),
          });
          if (!r.ok) {
            toast.danger(r.message);
            return;
          }
          toast.success(
            r.value.status !== p.status
              ? `Saved. ${p.name} needs ${r.value.domainVerified ? "a new test sign-in" : "its domain verified again"}.`
              : "Saved.",
          );
          onClose();
          router.refresh();
        })
      }
    >
      <TextField value={name} onChange={setName}>
        <Label>Name</Label>
        <Input />
      </TextField>
      <TextField value={domain} onChange={setDomain}>
        <Label>Email domain</Label>
        <Input spellCheck={false} />
        <span className="text-small text-muted-tertiary">A new domain needs its DNS record again.</span>
      </TextField>
      {p.linked ? (
        <p className="text-small text-muted">
          Someone has signed in through it, so its {p.protocol === "saml" ? "metadata" : "issuer and client"} can't
          change. Add a new provider for a new one.
        </p>
      ) : p.protocol === "oidc" ? (
        <>
          <TextField value={issuer} onChange={setIssuer}>
            <Label>New issuer URL</Label>
            <Input placeholder={p.issuer} spellCheck={false} />
          </TextField>
          <TextField value={clientId} onChange={setClientId}>
            <Label>New client ID</Label>
            <Input placeholder={p.settings?.clientId ?? ""} spellCheck={false} />
          </TextField>
        </>
      ) : (
        <TextField value={metadata} onChange={setMetadata}>
          <Label>New metadata (a URL or the XML)</Label>
          <TextArea rows={3} spellCheck={false} className="font-mono text-small" />
        </TextField>
      )}
    </Confirm>
  );
}

function SecretDialog({ provider: p, onClose }: { provider: SsoProviderView; onClose: () => void }) {
  const router = useRouter();
  const [secret, setSecret] = useState("");
  const [pending, start] = useTransition();
  return (
    <Confirm
      title={`Replace ${p.name}'s client secret`}
      action="Replace"
      pending={pending}
      disabled={!secret}
      onClose={onClose}
      onConfirm={() =>
        start(async () => {
          const r = await replaceSecret(p.providerId, secret);
          if (!r.ok) {
            toast.danger(r.message);
            return;
          }
          toast.success("The new secret is saved. Sign-ins use it from now on.");
          onClose();
          router.refresh();
        })
      }
    >
      <TextField value={secret} onChange={setSecret} autoFocus>
        <Label>New client secret</Label>
        <Input type="password" autoComplete="off" />
        <span className="text-small text-muted-tertiary">Sealed with this workspace's key. Never shown again.</span>
      </TextField>
    </Confirm>
  );
}

/** For someone back from a test sign-in who doesn't manage the workspace: the one step left. */
export function ActivateCard({ providerId }: { providerId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [done, setDone] = useState<string | null>(null);
  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-border px-5 py-4">
      <h1 className="text-display">Single sign-on</h1>
      <p className="text-body text-muted">
        You signed in through single sign-on ({providerId}). If you're testing it for your admin, activate it so they
        can require it.
      </p>
      {done ? (
        <p className="text-body text-success">{done}</p>
      ) : (
        <div>
          <Button
            isPending={pending}
            onPress={() =>
              start(async () => {
                const r = await activateProvider(providerId);
                if (!r.ok) toast.danger(r.message);
                else setDone(`${r.value.name} is active. Your admin can require it now.`);
                router.refresh();
              })
            }
          >
            Activate
          </Button>
        </div>
      )}
    </section>
  );
}

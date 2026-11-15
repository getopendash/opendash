"use client";

import { Button, Chip, Description, Input, Label, Modal, TextArea, TextField } from "@heroui/react";
import type { SsoProtocol, SsoProviderView } from "@opendash/core/enterprise";
import { CodeBlock } from "@opendash/ui";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { addProvider, showDnsRecord, verifyDomain } from "@/app/(app)/settings/single-sign-on/actions";
import { startSsoSignIn } from "./start-sign-in";

/** The id in the addresses an identity provider calls: from the name, lowercase and dashed, at most 40 characters. */
const idFrom = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");

const STEPS = ["Kind", "Settings", "Domain", "Test"] as const;

type Record = { name: string; label: string; value: string | null; expiresAt: string | null };

/**
 * Adding an identity provider: its kind and domain, what to paste into it and what to copy from it, then the DNS record
 * that proves the domain, then a test sign-in. Saved as a draft at the second step, so it can be closed and picked up
 * again from the table: `resume` opens it at the step the provider is on.
 */
export function AddProviderDialog({
  origin,
  isOpen,
  onOpenChange,
  resume,
}: {
  origin: string;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  /** A provider saved earlier: opens at its DNS record (a draft) or its test sign-in (verified). */
  resume?: SsoProviderView | null;
}) {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [kind, setKind] = useState<SsoProtocol>("oidc");
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const [providerId, setProviderId] = useState("");
  const [idTouched, setIdTouched] = useState(false);
  const [issuer, setIssuer] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [metadataUrl, setMetadataUrl] = useState("");
  const [metadataXml, setMetadataXml] = useState("");
  const [saved, setSaved] = useState<SsoProviderView | null>(null);
  const [record, setRecord] = useState<Record | null>(null);
  const [error, setError] = useState<{ message: string; detail?: string } | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    if (!isOpen) return;
    if (resume) {
      setSaved(resume);
      setName(resume.name);
      setKind(resume.protocol);
      setStep(resume.domainVerified ? 4 : 3);
    }
  }, [isOpen, resume]);

  useEffect(() => {
    if (step !== 3 || !saved || record) return;
    start(async () => {
      const r = await showDnsRecord(saved.providerId);
      if (r.ok) setRecord(r.value);
      else setError({ message: r.message });
    });
  }, [step, saved, record]);

  const reset = () => {
    setStep(1);
    setKind("oidc");
    setName("");
    setDomain("");
    setProviderId("");
    setIdTouched(false);
    setIssuer("");
    setClientId("");
    setClientSecret("");
    setMetadataUrl("");
    setMetadataXml("");
    setSaved(null);
    setRecord(null);
    setError(null);
  };
  const close = () => {
    reset();
    onOpenChange(false);
    router.refresh();
  };

  const id = idTouched ? providerId : idFrom(name);
  const pid = saved?.providerId ?? id;
  const shown = saved?.name ?? (name || "your identity provider");
  const ends = {
    redirect: `${origin}/api/auth/sso/callback/${pid}`,
    acs: `${origin}/api/auth/sso/saml2/sp/acs/${pid}`,
    entity: `${origin}/api/auth`,
    metadata: `${origin}/api/auth/sso/saml2/sp/metadata?providerId=${pid}`,
  };

  const save = () =>
    start(async () => {
      setError(null);
      const r = await addProvider(
        kind === "oidc"
          ? { protocol: "oidc", name, providerId: id, domain, issuer, clientId, clientSecret }
          : {
              protocol: "saml",
              name,
              providerId: id,
              domain,
              ...(metadataXml.trim() ? { metadataXml } : { metadataUrl }),
            },
      );
      if (!r.ok) {
        setError({ message: r.message });
        return;
      }
      setSaved(r.value);
      setClientSecret("");
      setStep(3);
    });

  const check = () =>
    start(async () => {
      if (!saved) return;
      setError(null);
      const r = await verifyDomain(saved.providerId);
      if (!r.ok) {
        setError({ message: r.message, ...(r.detail ? { detail: r.detail } : {}) });
        if (r.code === "TOKEN_EXPIRED") setRecord(null);
        return;
      }
      setSaved(r.value);
      setStep(4);
    });

  const canContinue = name.trim() && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain.trim()) && id.length > 0;
  const canSave =
    kind === "oidc" ? issuer.trim() && clientId.trim() && clientSecret : metadataUrl.trim() || metadataXml.trim();

  return (
    <Modal>
      <Modal.Backdrop isOpen={isOpen} onOpenChange={(open) => (open ? onOpenChange(true) : close())}>
        <Modal.Container size="lg" scroll="inside">
          <Modal.Dialog>
            <Modal.Header className="flex flex-col gap-2">
              <ol className="flex flex-wrap items-center gap-2 text-small text-muted-tertiary" aria-label="Steps">
                {STEPS.map((label, i) => (
                  <li
                    key={label}
                    aria-current={i + 1 === step ? "step" : undefined}
                    className={i + 1 === step ? "font-medium text-foreground" : ""}
                  >
                    {i + 1}. {label}
                  </li>
                ))}
              </ol>
              <Modal.Heading>{resume ? `Finish setting up ${resume.name}` : "Add an identity provider"}</Modal.Heading>
            </Modal.Header>
            <Modal.Body className="flex flex-col gap-5">
              {step === 1 ? (
                <>
                  <fieldset className="grid gap-2 @lg:grid-cols-2">
                    <legend className="sr-only">Kind</legend>
                    {(
                      [
                        ["oidc", "OIDC", "Entra ID, Google Workspace, Okta, Auth0…"],
                        ["saml", "SAML 2.0", "Okta, ADFS, OneLogin, JumpCloud…"],
                      ] as const
                    ).map(([value, title, hint]) => (
                      <button
                        key={value}
                        type="button"
                        aria-pressed={kind === value}
                        onClick={() => setKind(value)}
                        className={`flex cursor-pointer flex-col gap-0.5 rounded-xl border px-4 py-3 text-start ${kind === value ? "border-accent bg-accent-soft/40" : "border-border hover:bg-surface-secondary"}`}
                      >
                        <span className="text-body font-medium">{title}</span>
                        <span className="text-small text-muted">{hint}</span>
                      </button>
                    ))}
                  </fieldset>
                  <div className="flex flex-col gap-4 @lg:flex-row">
                    <TextField className="min-w-0 flex-1" value={name} onChange={setName} autoFocus>
                      <Label>Name</Label>
                      <Input placeholder="Okta" autoComplete="off" />
                      <Description>What your team sees here.</Description>
                    </TextField>
                    <TextField className="min-w-0 flex-1" value={domain} onChange={setDomain}>
                      <Label>Email domain</Label>
                      <Input placeholder="acme.com" autoComplete="off" spellCheck={false} />
                      <Description>Exactly this domain. A subdomain needs its own provider.</Description>
                    </TextField>
                  </div>
                  <TextField
                    value={id}
                    onChange={(v) => {
                      setIdTouched(true);
                      setProviderId(v.toLowerCase());
                    }}
                  >
                    <Label>Provider id</Label>
                    <Input className="font-mono" autoComplete="off" spellCheck={false} />
                    <Description>
                      In the addresses your identity provider calls and in the DNS record, so it can't change later.
                    </Description>
                  </TextField>
                </>
              ) : null}

              {step === 2 ? (
                <>
                  <section className="flex flex-col gap-2.5">
                    <h3 className="text-body font-semibold">Paste into {shown}</h3>
                    {kind === "oidc" ? (
                      <Field label="Redirect URI" value={ends.redirect} />
                    ) : (
                      <>
                        <Field label="ACS URL" value={ends.acs} />
                        <Field label="Entity ID (audience)" value={ends.entity} />
                        <Field label="Our metadata" value={ends.metadata} />
                      </>
                    )}
                  </section>
                  <section className="flex flex-col gap-4">
                    <h3 className="text-body font-semibold">From {shown}</h3>
                    {kind === "oidc" ? (
                      <>
                        <TextField value={issuer} onChange={setIssuer}>
                          <Label>Issuer URL</Label>
                          <Input placeholder="https://login.microsoftonline.com/…/v2.0" spellCheck={false} />
                        </TextField>
                        <div className="flex flex-col gap-4 @lg:flex-row">
                          <TextField className="min-w-0 flex-1" value={clientId} onChange={setClientId}>
                            <Label>Client ID</Label>
                            <Input autoComplete="off" spellCheck={false} />
                          </TextField>
                          <TextField className="min-w-0 flex-1" value={clientSecret} onChange={setClientSecret}>
                            <Label>Client secret</Label>
                            <Input type="password" autoComplete="off" />
                            <Description>Sealed with this workspace's key. Never shown again.</Description>
                          </TextField>
                        </div>
                      </>
                    ) : (
                      <>
                        <TextField
                          value={metadataUrl}
                          onChange={setMetadataUrl}
                          isDisabled={Boolean(metadataXml.trim())}
                        >
                          <Label>Identity provider metadata URL</Label>
                          <Input placeholder="https://acme.okta.com/app/…/sso/saml/metadata" spellCheck={false} />
                          <Description>
                            Read once, now. Its signing certificate comes from the metadata. OpenDash doesn't sign its
                            requests yet: if your provider requires signed requests, turn that off for OpenDash.
                          </Description>
                        </TextField>
                        <TextField value={metadataXml} onChange={setMetadataXml}>
                          <Label>Or paste the metadata XML</Label>
                          <TextArea rows={4} spellCheck={false} className="font-mono text-small" />
                        </TextField>
                      </>
                    )}
                  </section>
                </>
              ) : null}

              {step === 3 && saved ? (
                <>
                  <p className="text-body">
                    Add this TXT record to <strong>{saved.domain}</strong>'s DNS. It proves your workspace may claim the
                    domain. The value works for 7 days.
                  </p>
                  {record ? (
                    <>
                      <Field label="Name" value={record.name} />
                      <Field label="Value" value={record.value ?? ""} />
                      <p className="text-small text-muted-tertiary">
                        If your DNS provider asks only for a name, it's{" "}
                        <span className="font-mono">{record.label}</span>.
                      </p>
                    </>
                  ) : (
                    <p className="text-small text-muted">Getting the record…</p>
                  )}
                  <p className="text-small text-muted">
                    We ask the domain's own nameservers, so a record you've just added shows at once.
                  </p>
                </>
              ) : null}

              {step === 4 && saved ? (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <Chip size="sm" color="success" variant="soft">
                      {saved.domain} is verified
                    </Chip>
                  </div>
                  <p className="text-body">
                    Sign in through {saved.name} once, as yourself. Until a sign-in passes it already signs people in,
                    but it can't be required. You'll come back here to activate it.
                  </p>
                </>
              ) : null}

              {error ? (
                <div className="flex flex-col gap-1 rounded-xl bg-danger-soft px-3 py-2 text-small text-danger-soft-foreground">
                  <span>{error.message}</span>
                  {error.detail ? <span>{error.detail}</span> : null}
                </div>
              ) : null}
            </Modal.Body>
            <Modal.Footer className="flex flex-wrap justify-end gap-2">
              {step === 1 ? (
                <>
                  <Button variant="ghost" onPress={close}>
                    Cancel
                  </Button>
                  <Button isDisabled={!canContinue} onPress={() => setStep(2)}>
                    Continue
                  </Button>
                </>
              ) : step === 2 ? (
                <>
                  <Button variant="ghost" onPress={() => setStep(1)}>
                    Back
                  </Button>
                  <Button isDisabled={!canSave} isPending={pending} onPress={save}>
                    Save as draft
                  </Button>
                </>
              ) : step === 3 ? (
                <>
                  <Button variant="ghost" onPress={close}>
                    Finish later
                  </Button>
                  <Button isDisabled={!record?.value} isPending={pending} onPress={check}>
                    Check now
                  </Button>
                </>
              ) : (
                <>
                  <Button variant="ghost" onPress={close}>
                    Finish without testing
                  </Button>
                  <Button
                    isPending={pending}
                    onPress={() =>
                      start(async () => {
                        const r = saved ? await startSsoSignIn({ providerId: saved.providerId, test: true }) : null;
                        if (r && "message" in r) setError({ message: r.message });
                      })
                    }
                  >
                    Test sign-in
                  </Button>
                </>
              )}
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-small font-medium text-muted">{label}</span>
      <CodeBlock code={value} wrap label={`Copy ${label.toLowerCase()}`} />
    </div>
  );
}

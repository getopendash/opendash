"use client";

import {
  Alert,
  Button,
  Description,
  Input,
  Label,
  Modal,
  Radio,
  RadioGroup,
  Spinner,
  Switch,
  TextField,
  toast,
} from "@heroui/react";
import type { mcp } from "@opendash/core";
import { useQueryClient } from "@tanstack/react-query";
import { CircleCheck, Copy, Globe, TriangleAlert, Users } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactNode, useRef, useState } from "react";
import { api, apiQueries } from "@/lib/api";
import { mcpMessage, ServerGlyph, type SignInResult, useSignIn } from "./shared";

type Kind = "oauth" | "apikey" | "none";

/** A name to start with: what the server calls itself, else its domain ("mcp.example.com" → "Example"). */
function nameFor(found: mcp.Detection): string {
  if (found.server?.name) return found.server.name.slice(0, 80);
  const host = found.host.replace(/:\d+$/, "");
  // An address by number, or a single name (localhost): nothing to make a name of.
  if (/^[\d.]+$/.test(host) || host.startsWith("[") || !host.includes(".")) return "";
  const parts = host.split(".");
  const word = parts.length >= 2 ? (parts[parts.length - 2] ?? found.host) : (parts[0] ?? found.host);
  return word.charAt(0).toUpperCase() + word.slice(1);
}

const hostOf = (url: string | null) => {
  try {
    return url ? new URL(url).host : null;
  } catch {
    return url;
  }
};

function Check({ ok = true, title, detail }: { ok?: boolean; title: ReactNode; detail?: ReactNode }) {
  return (
    <li className="flex items-start gap-2.5 py-1">
      {ok ? (
        <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
      ) : (
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
      )}
      <span className="flex min-w-0 flex-col">
        <span className="text-small font-medium">{title}</span>
        {detail ? <span className="text-micro text-muted">{detail}</span> : null}
      </span>
    </li>
  );
}

/** What detection found, as the checks it passed. */
function Checks({ found }: { found: mcp.Detection }) {
  const a = found.auth;
  const transport = found.transport === "sse" ? "the older HTTP with server-sent events" : "streamable HTTP";
  return (
    <ul className="flex flex-col rounded-xl bg-surface-secondary px-3.5 py-2">
      <Check title={`Reached ${found.host}`} />
      <Check
        title="It speaks MCP"
        detail={found.server ? `${transport} · “${found.server.name}”` : "it asked for a sign-in before saying more"}
      />
      {a.kind === "oauth" ? (
        <Check
          ok={a.registration !== "needs_client"}
          title={`It signs in with OAuth, through ${hostOf(a.issuer) ?? "its own sign-in"}`}
          detail={
            a.registration === "dynamic"
              ? "OpenDash can register itself there: nothing to paste"
              : a.registration === "metadata_document"
                ? "It takes OpenDash's client metadata as its client ID: nothing to paste"
                : "It can't register OpenDash: make an OAuth app there and enter it below"
          }
        />
      ) : a.kind === "apikey" ? (
        <Check ok={false} title="It needs an API key" detail="It refused without one, and offered no sign-in" />
      ) : (
        <Check
          title="No sign-in"
          detail={`It answered without asking for one${a.tools !== null ? ` · ${a.tools} tools` : ""}`}
        />
      )}
    </ul>
  );
}

function Choice({ value, title, description }: { value: string; title: string; description: string }) {
  return (
    <Radio
      value={value}
      className="mt-0 rounded-xl border border-border px-3 py-2.5 data-selected:border-accent data-selected:bg-accent-soft/40"
    >
      <Radio.Content className="flex items-center gap-2.5 text-small font-medium">
        <Radio.Control>
          <Radio.Indicator />
        </Radio.Control>
        {title}
      </Radio.Content>
      <Description className="pl-7 text-micro text-muted">{description}</Description>
    </Radio>
  );
}

function Field({
  label,
  value,
  onChange,
  secret,
  mono,
  placeholder,
  hint,
  isDisabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  secret?: boolean;
  mono?: boolean;
  placeholder?: string;
  hint?: string;
  isDisabled?: boolean;
}) {
  return (
    <TextField className="w-full" value={value} onChange={onChange} isDisabled={isDisabled}>
      <Label>{label}</Label>
      <Input
        type={secret ? "password" : "text"}
        autoComplete="off"
        spellCheck={false}
        className={mono ? "font-mono text-small" : undefined}
        {...(placeholder ? { placeholder } : {})}
      />
      {hint ? <Description>{hint}</Description> : null}
    </TextField>
  );
}

const SectionLabel = ({ children }: { children: ReactNode }) => (
  <span className="text-micro font-semibold tracking-wide text-muted-tertiary uppercase">{children}</span>
);

/**
 * Adding a server: paste its address; OpenDash finds how it signs people in; the admin picks whose
 * account it uses (and enters a client or a key where one's needed); then signs in or adds a key, so its tools can be
 * listed; and lands on the server's page to review them.
 */
export function AddServerDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [url, setUrl] = useState("");
  const [found, setFound] = useState<mcp.Detection | null>(null);
  const [kind, setKind] = useState<Kind>("oauth");
  const [name, setName] = useState("");
  const [access, setAccess] = useState<"personal" | "shared">("personal");
  const [dashboards, setDashboards] = useState(true);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [headerName, setHeaderName] = useState("Authorization");
  const [key, setKey] = useState("");
  const [hint, setHint] = useState("");
  const [serverId, setServerId] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "detect" | "save" | "list">(null);
  const [error, setError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);

  const refresh = () => queryClient.invalidateQueries({ queryKey: apiQueries.mcp.key() });
  // Once it's approved, what was approved is fixed here: only the key (or the sign-in) can be tried again.
  const locked = !!serverId;
  const urlRef = useRef(url);
  const editUrl = (next: string) => {
    setUrl(next);
    urlRef.current = next;
    // What was found belongs to the address it was found at.
    setFound(null);
    setError(null);
  };

  /** Lists its tools through the account just connected, then opens its page to review them. */
  const listAndOpen = async (id: string) => {
    setBusy("list");
    try {
      const listed = await api.mcp.listTools({ serverId: id });
      if (listed.state !== "ready") {
        setError("Its tools couldn't be listed yet. Open its page and press Test once it's connected.");
      }
      await refresh();
      toast.success(`${name} added. Review what its tools may do.`);
      onClose();
      router.push(`/settings/connections/${id}`);
    } catch (e) {
      setError(mcpMessage(e, "Its tools couldn't be listed. Try Test on its page."));
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  const signIn = useSignIn((result: SignInResult) => {
    if (!serverId || (result.serverId && result.serverId !== serverId)) return;
    setSigningIn(false);
    if (result.state === "ready") void listAndOpen(serverId);
    else setError(result.state === "problem" ? result.message : "You signed in as a different account. Try again.");
  });

  const detect = async () => {
    setBusy("detect");
    setError(null);
    const asked = url.trim();
    try {
      const next = await api.mcp.detect({ url: asked });
      // An answer for an address that's since been edited is dropped.
      if (urlRef.current.trim() !== asked) return;
      setFound(next);
      setKind(next.auth.kind);
      setName(nameFor(next));
      setAccess(next.auth.kind === "none" ? "shared" : "personal");
    } catch (e) {
      if (urlRef.current.trim() !== asked) return;
      setFound(null);
      setError(mcpMessage(e, "Couldn't check that address. Try again."));
    } finally {
      setBusy(null);
    }
  };

  const oauth = found?.auth.kind === "oauth" ? found.auth : null;
  const needsClient = kind === "oauth" && oauth?.registration === "needs_client";
  const sharedKey = kind === "apikey" && access === "shared";
  const ready =
    !!found &&
    name.trim().length > 0 &&
    (!needsClient || clientId.trim().length > 0) &&
    (kind !== "apikey" || headerName.trim().length > 0) &&
    (kind !== "apikey" || key.trim().length > 0);

  /** Approves it (once), then sets the key or goes on to sign in. */
  const save = async () => {
    if (!found) return;
    setBusy("save");
    setError(null);
    let id = serverId;
    try {
      if (!id) {
        const made = await api.mcp.approve({
          name: name.trim(),
          url: found.url,
          auth: kind,
          transport: found.transport,
          access: kind === "none" ? "shared" : access,
          dashboardsAllowed: dashboards,
          client:
            needsClient && oauth?.issuer
              ? { clientId: clientId.trim(), clientSecret: clientSecret.trim() || null, issuer: oauth.issuer }
              : null,
          keyHeader: kind === "apikey" ? headerName.trim() : null,
          keyFormat: kind === "apikey" ? "{key}" : null,
          keyHint: kind === "apikey" && access === "personal" ? hint.trim() || null : null,
        });
        id = made.id;
        setServerId(id);
        await refresh();
      }
      if (kind === "apikey") {
        await api.mcp.putKey({ serverId: id, key: key.trim() });
        setKey("");
        setBusy(null);
        await listAndOpen(id);
        return;
      }
      if (kind === "none") {
        setBusy(null);
        await listAndOpen(id);
        return;
      }
      setBusy(null);
      setSigningIn(true);
    } catch (e) {
      setBusy(null);
      setError(mcpMessage(e, "Couldn't add it. Try again."));
    }
  };

  const redirectUrl = typeof window === "undefined" ? "" : `${window.location.origin}/api/mcp/callback`;
  const title = found ? `Add ${name.trim() || found.host}` : "Add an MCP server";

  return (
    <Modal>
      <Modal.Backdrop isOpen onOpenChange={(o) => !o && onClose()}>
        <Modal.Container size="lg" scroll="inside">
          <Modal.Dialog aria-label={title}>
            <Modal.CloseTrigger />
            <Modal.Header className="border-b border-border pb-3">
              {/* Once its address is found, the service's mark (by the address, never the name typed). */}
              <Modal.Heading className="flex items-center gap-2.5">
                {found ? <ServerGlyph name={name || found.host} host={found.host} size="sm" /> : null}
                {title}
              </Modal.Heading>
            </Modal.Header>
            <Modal.Body className="flex flex-col gap-4 pt-3">
              {signingIn && serverId ? (
                <section className="flex flex-col gap-3">
                  <p className="text-small text-muted">
                    {access === "shared"
                      ? `Sign in with the account everyone will use for ${name}. Use one made for reporting, with read access, if you have one.`
                      : `Sign in with your own ${name} account, so its tools can be listed. Everyone else connects their own.`}
                  </p>
                  <div className="flex flex-col items-center gap-3 rounded-xl border border-border px-4 py-6 text-center">
                    {signIn.pending ? (
                      <Spinner size="sm" />
                    ) : found ? (
                      <ServerGlyph name={name || found.host} host={found.host} size="lg" />
                    ) : (
                      <Globe className="size-5 text-muted" aria-hidden />
                    )}
                    <span className="text-small font-medium">
                      {signIn.pending
                        ? `Finish signing in to ${name} in the window that opened`
                        : busy === "list"
                          ? "Listing its tools…"
                          : `Sign in to ${name}`}
                    </span>
                    <Button
                      size="sm"
                      variant={signIn.pending ? "outline" : "primary"}
                      isPending={busy === "list"}
                      onPress={() => void signIn.start(serverId)}
                    >
                      {signIn.pending ? "Open the window again" : "Sign in"}
                    </Button>
                  </div>
                  <p className="text-micro text-muted-tertiary">
                    It's added already: if you stop here, sign in from its page later.
                  </p>
                </section>
              ) : (
                <>
                  <TextField className="w-full" value={url} onChange={editUrl} isDisabled={locked}>
                    <Label>Server address</Label>
                    <div className="flex gap-2">
                      <Input
                        className="min-w-0 flex-1 font-mono text-small"
                        placeholder="https://mcp.example.com/mcp"
                        autoComplete="off"
                        spellCheck={false}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && url.trim()) void detect();
                        }}
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        isDisabled={!url.trim() || locked}
                        isPending={busy === "detect"}
                        onPress={() => void detect()}
                      >
                        Check
                      </Button>
                    </div>
                    <Description>
                      The address the service gives for MCP. OpenDash finds out how it signs people in.
                    </Description>
                  </TextField>

                  {found ? (
                    <>
                      <Checks found={found} />
                      <Field label="Name" value={name} onChange={setName} isDisabled={locked} />

                      {kind === "none" ? (
                        <Alert status="warning">
                          <Alert.Indicator>
                            <Users className="size-4" aria-hidden />
                          </Alert.Indicator>
                          <Alert.Content>
                            <Alert.Title>One connection for everyone</Alert.Title>
                            <Alert.Description>
                              Anyone who can use it here sees the same data. Add it only if everyone in the workspace
                              may see what it returns.
                            </Alert.Description>
                          </Alert.Content>
                        </Alert>
                      ) : (
                        <div className="flex flex-col gap-2">
                          <SectionLabel>{kind === "apikey" ? "Whose key" : "Whose account does it use?"}</SectionLabel>
                          <RadioGroup
                            aria-label="Whose account"
                            isDisabled={locked}
                            value={access}
                            onChange={(v) => setAccess(v as "personal" | "shared")}
                            className="flex flex-col gap-2"
                          >
                            <Choice
                              value="personal"
                              title={kind === "apikey" ? "Each person adds their own key" : "Each person's own"}
                              description={
                                kind === "apikey"
                                  ? "People see what their own key can see."
                                  : "Everyone connects their own account and sees only what it can see. Recommended."
                              }
                            />
                            <Choice
                              value="shared"
                              title={kind === "apikey" ? "One key for everyone" : "One account for everyone"}
                              description={
                                kind === "apikey"
                                  ? "Entered now. Use a read-only key if the service has them."
                                  : "You sign in next; everyone using it sees what that one account can see."
                              }
                            />
                          </RadioGroup>
                        </div>
                      )}

                      {needsClient ? (
                        <div className="flex flex-col gap-3 rounded-xl border border-border p-3.5">
                          <p className="text-small text-muted">
                            Make an OAuth app in {hostOf(oauth?.issuer ?? null) ?? "the service"}'s settings, give it
                            this redirect URL, and enter what it gives you.
                          </p>
                          <div className="flex items-center gap-2 rounded-lg bg-surface-secondary px-2.5 py-1.5">
                            <code className="min-w-0 flex-1 truncate font-mono text-micro">{redirectUrl}</code>
                            <Button
                              size="sm"
                              variant="ghost"
                              isIconOnly
                              aria-label="Copy the redirect URL"
                              onPress={() =>
                                void navigator.clipboard.writeText(redirectUrl).then(() => toast.success("Copied."))
                              }
                            >
                              <Copy className="size-3.5" aria-hidden />
                            </Button>
                          </div>
                          <Field label="Client ID" value={clientId} onChange={setClientId} mono isDisabled={locked} />
                          <Field
                            label="Client secret"
                            value={clientSecret}
                            onChange={setClientSecret}
                            secret
                            mono
                            hint="Kept encrypted, sent only to where it was made. Leave it empty for a public client."
                            isDisabled={locked}
                          />
                        </div>
                      ) : null}

                      {kind === "apikey" ? (
                        <div className="flex flex-col gap-3">
                          <Field
                            label="Header name"
                            value={headerName}
                            onChange={setHeaderName}
                            placeholder="Authorization"
                            mono
                            isDisabled={locked}
                          />
                          {access === "personal" ? (
                            <Field
                              label="Where people find their key"
                              value={hint}
                              onChange={setHint}
                              placeholder="Settings → Developers → API keys"
                              hint="Shown when someone adds theirs."
                              isDisabled={locked}
                            />
                          ) : null}
                          <Field
                            label={access === "shared" ? "Header value, used by everyone" : "Your header value"}
                            value={key}
                            onChange={setKey}
                            placeholder="Basic dXNlcjpwYXNz or Bearer sk-…"
                            secret
                            mono
                            hint="Sent exactly as you type it, scheme included. Tested before it's kept: its tools are listed and nothing is called."
                          />
                        </div>
                      ) : null}

                      {locked ? null : kind === "oauth" ? (
                        <button
                          type="button"
                          className="w-fit text-small text-muted underline-offset-2 hover:underline"
                          onClick={() => setKind("apikey")}
                        >
                          It takes an API key too? Use a key instead
                        </button>
                      ) : found.auth.kind === "oauth" ? (
                        <button
                          type="button"
                          className="w-fit text-small text-muted underline-offset-2 hover:underline"
                          onClick={() => setKind("oauth")}
                        >
                          Sign in with OAuth instead
                        </button>
                      ) : null}

                      <div className="flex flex-col gap-2">
                        <SectionLabel>Who may use it</SectionLabel>
                        <p className="text-small text-muted">The analyst, in conversations, always.</p>
                        <Switch size="sm" isSelected={dashboards} onChange={setDashboards} isDisabled={locked}>
                          <Switch.Content>
                            <Label className="text-small">Dashboards</Label>
                            <Switch.Control>
                              <Switch.Thumb />
                            </Switch.Control>
                          </Switch.Content>
                          <Description className="text-micro">
                            {access === "personal" && kind !== "none"
                              ? "Sections read it as each viewer."
                              : "Sections read it with the one account."}{" "}
                            Only tools that read.
                          </Description>
                        </Switch>
                      </div>
                    </>
                  ) : null}
                </>
              )}
            </Modal.Body>
            <Modal.Footer className="flex items-center gap-2 border-t border-border pt-3">
              {error ? (
                <span role="alert" className="min-w-0 flex-1 text-small text-danger wrap-anywhere">
                  {error}
                </span>
              ) : (
                <span className="min-w-0 flex-1 text-micro text-muted-tertiary">
                  {found && !signingIn
                    ? kind === "oauth"
                      ? "Next: sign in, then its tools."
                      : "Next: its tools."
                    : null}
                </span>
              )}
              <Button size="sm" variant="ghost" onPress={onClose}>
                {serverId ? "Close" : "Cancel"}
              </Button>
              {found && !signingIn ? (
                <Button
                  size="sm"
                  isDisabled={!ready}
                  isPending={busy === "save" || busy === "list"}
                  onPress={() => void save()}
                >
                  {kind === "oauth" ? "Continue" : sharedKey || kind === "apikey" ? "Test and add" : "Add"}
                </Button>
              ) : null}
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}

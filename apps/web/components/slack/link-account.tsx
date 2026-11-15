"use client";

import { Button, Spinner } from "@heroui/react";
import { OpenDashLogo } from "@opendash/ui";
import { ArrowLeftRight, Check, Hash, Link2Off } from "lucide-react";
import { useEffect, useState } from "react";
import { signOutTo } from "@/lib/sign-out";

type State =
  | { kind: "loading" }
  | { kind: "preview"; teamName: string; slackUserName: string | null; you: string; workspace: string }
  | { kind: "linked"; teamName: string }
  | { kind: "sign_in" }
  | { kind: "other_workspace" }
  | { kind: "viewer" }
  | { kind: "not_yours"; slackEmail: string | null; you: string | null }
  | { kind: "declined" }
  | { kind: "invalid" };

const SIGN_IN = "/sign-in?next=%2Fslack%2Flink";

/** Asks the link route: with the token the first time, then with none (it keeps it while they sign in). */
async function send(token: string, confirm: boolean): Promise<State> {
  try {
    const r = await fetch("/api/slack/link", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...(token ? { token } : {}), ...(confirm ? { confirm: true } : {}) }),
    });
    const body = (await r.json()) as {
      ok: boolean;
      reason?: string;
      preview?: State;
      linked?: { teamName: string };
      slackEmail?: string | null;
      you?: string | null;
    };
    if (body.ok && body.linked) return { kind: "linked", teamName: body.linked.teamName };
    if (body.ok && body.preview) return { ...(body.preview as object), kind: "preview" } as State;
    if (body.reason === "not_yours") {
      return { kind: "not_yours", slackEmail: body.slackEmail ?? null, you: body.you ?? null };
    }
    if (body.reason === "sign_in" || body.reason === "other_workspace" || body.reason === "viewer") {
      return { kind: body.reason };
    }
    return { kind: "invalid" };
  } catch {
    return { kind: "invalid" };
  }
}

/**
 * Someone confirms, signed in, that their Slack account asks OpenDash as them. The token is the
 * link's fragment: sent once to the link route, which keeps it while they sign in (even in another tab), never put in
 * an address a server sees, and taken out of the address bar.
 */
export function LinkAccount() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [pending, setPending] = useState(false);
  useEffect(() => {
    const open = () => {
      const t = window.location.hash.slice(1);
      if (window.location.hash) window.history.replaceState(null, "", window.location.pathname);
      setState({ kind: "loading" });
      void send(t, false).then(setState);
    };
    open();
    // Another link opened in this tab changes only the fragment: read it too.
    const onHash = () => window.location.hash && open();
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const confirm = async () => {
    setPending(true);
    setState(await send("", true));
    setPending(false);
  };
  const switchAccount = async () => {
    setPending(true);
    if (!(await signOutTo(SIGN_IN))) setPending(false);
  };

  return (
    <div className="flex h-full items-center justify-center px-4">
      <section className="flex w-full max-w-md flex-col gap-5 rounded-2xl border border-border bg-surface p-7">
        <div className="flex items-center gap-2">
          <OpenDashLogo className="h-5" />
          <ArrowLeftRight className="size-3.5 text-muted-tertiary" aria-hidden />
          <Hash className="size-4" aria-hidden />
        </div>
        {state.kind === "loading" ? (
          <Spinner size="sm" />
        ) : state.kind === "preview" ? (
          <>
            <div className="flex flex-col gap-1.5">
              <h1 className="text-title">Link your Slack account</h1>
              <p className="text-body text-muted">
                Then you ask OpenDash in Slack as yourself, with the access you have here.
              </p>
            </div>
            <dl className="flex flex-col gap-2.5 rounded-xl bg-default p-3.5 text-body">
              {[
                ["Slack", `${state.slackUserName ? `${state.slackUserName} in ` : ""}${state.teamName}`],
                ["OpenDash", state.you],
                ["Workspace", state.workspace],
              ].map(([k, v]) => (
                <div key={k} className="flex gap-3">
                  <dt className="w-24 shrink-0 text-muted-tertiary">{k}</dt>
                  <dd className="min-w-0 break-words">{v}</dd>
                </div>
              ))}
            </dl>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onPress={() => setState({ kind: "declined" })}>
                Not now
              </Button>
              <Button size="sm" variant="primary" isPending={pending} onPress={() => void confirm()}>
                Link account
              </Button>
            </div>
            <p className="text-small text-muted-tertiary">
              The link works once and for 10 minutes. Unlink any time in Settings → Security.
            </p>
          </>
        ) : state.kind === "linked" ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <h1 className="flex items-center gap-2 text-title">
                <Check className="size-5 text-success" aria-hidden />
                You're linked
              </h1>
              <p className="text-body text-muted">
                Go back to {state.teamName} and ask: in OpenDash's Agents tab, a direct message, or a channel thread
                when you mention @OpenDash.
              </p>
            </div>
            <p className="text-small text-muted-tertiary">Unlink any time in Settings → Security.</p>
          </div>
        ) : state.kind === "sign_in" ? (
          <div className="flex flex-col gap-3">
            <h1 className="text-title">Sign in to link your Slack account</h1>
            <p className="text-body text-muted">Sign in to OpenDash, and this page asks you to confirm.</p>
            <Button size="sm" variant="primary" className="self-start" onPress={() => window.location.assign(SIGN_IN)}>
              Sign in
            </Button>
          </div>
        ) : state.kind === "declined" ? (
          <div className="flex flex-col gap-1.5">
            <h1 className="text-title">Not linked</h1>
            <p className="text-body text-muted">
              Nothing changed. Open the link again while it works, or ask OpenDash in Slack for a new one.
            </p>
          </div>
        ) : state.kind === "not_yours" ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <h1 className="flex items-center gap-2 text-title">
                <Link2Off className="size-5 text-muted" aria-hidden />
                This link is for someone else
              </h1>
              <p className="text-body text-muted">
                {state.slackEmail
                  ? `Its Slack account's email, ${state.slackEmail}, isn't the one you sign in with here${state.you ? ` (${state.you})` : ""}.`
                  : "Slack didn't share that account's email, so OpenDash can't check it's yours."}{" "}
                Open the link from your own Slack account, or sign in here with that email.
              </p>
            </div>
            <Button
              size="sm"
              variant="primary"
              className="self-start"
              isPending={pending}
              onPress={() => void switchAccount()}
            >
              Sign in as someone else
            </Button>
            <p className="text-small text-muted-tertiary">
              A link only ever connects a Slack account to the person it belongs to. Nothing was linked.
            </p>
          </div>
        ) : state.kind === "viewer" ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <h1 className="flex items-center gap-2 text-title">
                <Link2Off className="size-5 text-muted" aria-hidden />
                Asking needs member access
              </h1>
              <p className="text-body text-muted">
                You're a viewer in this workspace: you read the conversations shared with you here. Ask an owner or
                admin to make you a member, then ask again in Slack.
              </p>
            </div>
            <Button size="sm" variant="primary" className="self-start" onPress={() => window.location.assign("/")}>
              Open OpenDash
            </Button>
            <p className="text-small text-muted-tertiary">Nothing was linked.</p>
          </div>
        ) : state.kind === "other_workspace" ? (
          <div className="flex flex-col gap-1.5">
            <h1 className="text-title">This link is for another workspace</h1>
            <p className="text-body text-muted">
              Switch to the OpenDash workspace that's connected to this Slack (the workspace menu, top left), then open
              the link again.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            <h1 className="flex items-center gap-2 text-title">
              <Link2Off className="size-5 text-muted" aria-hidden />
              This link doesn't work
            </h1>
            <p className="text-body text-muted">
              It was used, or it expired. Ask OpenDash in Slack again for a new one.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}

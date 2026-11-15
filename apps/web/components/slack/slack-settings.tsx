"use client";

import { AlertDialog, Avatar, Button, toast } from "@heroui/react";
import { Copy, FileInput, FileOutput, Hash, Unplug } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { disconnectSlackAction, unlinkSlackAction } from "@/app/(app)/settings/slack/actions";
import { confirmSlackInstallAction } from "@/app/(app)/settings/slack/confirm-action";
import { heldSlackInstallAction } from "@/app/(app)/settings/slack/held-action";

export interface SlackSettingsProps {
  /** How an Add to Slack just ended, if it did. */
  notice?: { tone: "success" | "danger"; text: string } | null;
  /** How this deployment's Slack app is set up (@opendash/slack's slackSetup). */
  setup: { kind: "off"; missing: string[]; legacyToken: boolean } | { kind: "oauth"; socket: boolean };
  /** Where Slack reaches OpenDash (SLACK_PUBLIC_URL, or the web app's own https address); null when it has none. */
  address: string | null;
  workspace: {
    teamName: string;
    teamDomain: string | null;
    connectedBy: string | null;
    connectedAt: string;
    /** Slack took the app back. */
    removed: { at: string; why: "uninstalled" | "tokens_revoked" } | null;
  } | null;
  people: { slackUserId: string; name: string; slackName: string | null; linkedAt: string }[];
}

const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const initials = (name: string) =>
  name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");

/** The manifest command for this deployment: the address Slack reaches it at, and Socket Mode. */
const manifestCommand = (address: string | null, socket: boolean) =>
  `pnpm slack:manifest ${address ?? "https://<your OpenDash address>"}${socket ? " --socket" : ""}`;

/**
 * Slack for this workspace. Whoever runs OpenDash sets up its Slack app once; then
 * owners and admins add it to Slack, unlink people, and disconnect it; Slack can take it back too.
 */
export function SlackSettings({ notice, setup, address, workspace, people }: SlackSettingsProps) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const run = async (
    key: string,
    action: () => Promise<{ ok: true; message?: string } | { ok: false; message: string }>,
    done: string,
  ) => {
    setPending(key);
    const r = await action();
    setPending(null);
    if (!r.ok) return void toast.danger(r.message);
    if (r.message) toast.warning(r.message);
    else toast.success(done);
    router.refresh();
  };
  const https = Boolean(address?.startsWith("https:"));
  // Back from Slack: the install is held until this person, in this browser, presses Connect on a card that
  // names both workspaces (its review: never connected on the page's load alone). The code is in the fragment.
  const [held, setHeld] = useState<{ installId: string; code: string; teamName: string; workspace: string } | null>(
    null,
  );
  const read = useRef(false);
  useEffect(() => {
    const [installId, code] = window.location.hash.slice(1).split(".");
    if (read.current || !new URLSearchParams(window.location.search).has("slack") || !installId || !code) return;
    read.current = true;
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    void heldSlackInstallAction(installId, code).then(
      (found) =>
        found ? setHeld({ installId, code, ...found }) : router.replace("/settings/slack?slack=not_this_browser"),
      () => router.replace("/settings/slack?slack=failed"),
    );
  }, [router]);
  const connect = async () => {
    if (!held) return;
    setPending("connect");
    const done = await confirmSlackInstallAction(held.installId, held.code).catch(() => ({ outcome: "failed" }));
    setPending(null);
    setHeld(null);
    router.replace(`/settings/slack?slack=${done.outcome}`);
  };
  const addToSlack = (label: string) => (
    // A form posted from this page: the only way an install starts (its review: never from a link or redirect).
    <form method="post" action="/api/slack/install">
      <Button type="submit" size="sm" variant="primary" isDisabled={!https}>
        <Hash className="size-3.5" aria-hidden />
        {label}
      </Button>
    </form>
  );

  return (
    <div className="flex max-w-3xl flex-col gap-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-display font-semibold">Slack</h1>
        <p className="text-body text-muted">
          Ask OpenDash in Slack, in its Agents tab or a direct message: as yourself, with the access you have here,
          every number traced to its query.
        </p>
      </header>

      {held ? (
        <section
          aria-labelledby="slack-held"
          className="flex flex-col gap-3 rounded-2xl border border-accent px-5 py-4"
        >
          <div className="flex flex-col gap-1">
            <h2 id="slack-held" className="text-body font-semibold">
              Connect {held.teamName} to {held.workspace}?
            </h2>
            <p className="text-small text-muted">
              You approved OpenDash in Slack. Connect it only if you pressed Add to Slack here just now: people in{" "}
              {held.teamName} will then ask OpenDash about {held.workspace}'s data, as themselves.
            </p>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="primary" isPending={pending === "connect"} onPress={() => void connect()}>
              <Hash className="size-3.5" aria-hidden />
              Connect
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onPress={() => {
                setHeld(null);
                router.replace("/settings/slack");
              }}
            >
              Not now
            </Button>
          </div>
        </section>
      ) : notice ? (
        <p
          role="status"
          className={`rounded-lg px-3 py-2 text-small ${notice.tone === "success" ? "bg-success-soft text-success-soft-foreground" : "bg-danger-soft text-danger-soft-foreground"}`}
        >
          {notice.text}
        </p>
      ) : null}

      {workspace?.removed ? (
        <section aria-labelledby="slack-workspace" className="flex flex-col gap-2">
          <h2 id="slack-workspace" className="text-body font-semibold">
            Workspace
          </h2>
          <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-border px-4 py-3">
            <Unplug className="size-4 shrink-0" aria-hidden />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-body">{workspace.teamName}</span>
              <span className="text-small text-muted-tertiary">
                Slack{" "}
                {workspace.removed.why === "uninstalled" ? "removed OpenDash from" : "revoked OpenDash's access to"}{" "}
                this workspace on {DAY.format(new Date(workspace.removed.at))}. Its token is deleted, and nobody here
                can ask from Slack until it's added again.
              </span>
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="ghost"
                isPending={pending === "disconnect"}
                onPress={() => void run("disconnect", disconnectSlackAction, "Slack is forgotten here.")}
              >
                Forget it
              </Button>
              {setup.kind === "oauth" ? addToSlack("Add to Slack again") : null}
            </div>
          </div>
          {!https && setup.kind === "oauth" ? <HttpsNote /> : null}
        </section>
      ) : workspace ? (
        <>
          <section aria-labelledby="slack-workspace" className="flex flex-col gap-2">
            <h2 id="slack-workspace" className="text-body font-semibold">
              Workspace
            </h2>
            <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-border px-4 py-3">
              <Hash className="size-4 shrink-0" aria-hidden />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-body">{workspace.teamName}</span>
                <span className="text-small text-muted-tertiary">
                  {[
                    workspace.teamDomain ? `${workspace.teamDomain}.slack.com` : null,
                    `connected${workspace.connectedBy ? ` by ${workspace.connectedBy}` : ""}, ${DAY.format(new Date(workspace.connectedAt))}`,
                    "answers in the thread where it's asked",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </div>
              <Button size="sm" variant="danger-soft" onPress={() => setDisconnecting(true)}>
                <Unplug className="size-3.5" aria-hidden />
                Disconnect
              </Button>
            </div>
          </section>

          <section aria-labelledby="slack-people" className="flex flex-col gap-2">
            <h2 id="slack-people" className="text-body font-semibold">
              Linked people · {people.length}
            </h2>
            {people.length ? (
              <ul className="flex flex-col divide-y divide-border rounded-2xl border border-border">
                {people.map((p) => (
                  <li key={p.slackUserId} className="flex items-center gap-3 px-4 py-2.5">
                    <Avatar size="sm">
                      <Avatar.Fallback>{initials(p.name)}</Avatar.Fallback>
                    </Avatar>
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-body">{p.name}</span>
                      <span className="text-small text-muted-tertiary">
                        {p.slackName && p.slackName !== p.name ? `${p.slackName} in Slack · ` : ""}linked{" "}
                        {DAY.format(new Date(p.linkedAt))}
                      </span>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      isPending={pending === p.slackUserId}
                      onPress={() =>
                        void run(p.slackUserId, () => unlinkSlackAction(p.slackUserId), `${p.name} is unlinked.`)
                      }
                    >
                      Unlink
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="rounded-2xl border border-border px-4 py-3 text-body text-muted">Nobody has linked yet.</p>
            )}
            <p className="text-small text-muted-tertiary">
              People link their Slack account the first time they ask, by signing in here with the same email. Removing
              someone from this workspace unlinks them at once.
            </p>
          </section>
        </>
      ) : setup.kind === "off" ? (
        <section
          aria-labelledby="slack-setup"
          className="flex flex-col gap-4 rounded-2xl border border-border px-5 py-5"
        >
          <div className="flex flex-wrap items-center gap-3">
            <Hash className="size-5 shrink-0" aria-hidden />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <h2 id="slack-setup" className="text-body font-semibold">
                Set up OpenDash's Slack app
              </h2>
              <p className="text-small text-muted-tertiary">
                This deployment has no Slack app yet. Whoever runs OpenDash creates it once; then an owner or admin of
                any workspace here adds it to Slack.
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              onPress={() =>
                void navigator.clipboard.writeText(manifestCommand(address, false)).then(
                  () => toast.success("Copied."),
                  () => toast.danger("Couldn't copy it."),
                )
              }
            >
              <Copy className="size-3.5" aria-hidden />
              Copy the command
            </Button>
          </div>
          {setup.legacyToken ? (
            <p className="rounded-lg bg-surface-secondary px-3 py-2 text-small text-muted">
              SLACK_BOT_TOKEN isn't used any more: every workspace adds OpenDash with Add to Slack. Keep the same app,
              and add its SLACK_CLIENT_ID and SLACK_CLIENT_SECRET from Basic Information.
            </p>
          ) : null}
          <Steps
            steps={[
              [
                "Create the app from OpenDash's manifest",
                `Run ${manifestCommand(address, false)} (locally, your tunnel's address). At api.slack.com/apps, choose Create New App, From a manifest, and paste it; or paste it over an existing app's App Manifest.`,
              ],
              [
                "Put its keys in OpenDash's settings",
                `From Basic Information: SLACK_CLIENT_ID, SLACK_CLIENT_SECRET and SLACK_SIGNING_SECRET, and SLACK_PUBLIC_URL when Slack can't reach OpenDash's own address. Still missing: ${setup.missing.join(", ")}.`,
              ],
              [
                "Restart OpenDash",
                "Then Add to Slack appears here. Each Slack workspace that adds it gets its own token, kept encrypted.",
              ],
            ]}
          />
        </section>
      ) : (
        <section
          aria-labelledby="slack-connect"
          className="flex flex-col gap-4 rounded-2xl border border-border px-5 py-5"
        >
          <div className="flex flex-wrap items-center gap-3">
            <Hash className="size-5 shrink-0" aria-hidden />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <h2 id="slack-connect" className="text-body font-semibold">
                Connect your Slack workspace
              </h2>
              <p className="text-small text-muted-tertiary">
                Only an owner or admin connects it. One Slack workspace belongs to one OpenDash workspace.
              </p>
            </div>
            {addToSlack("Add to Slack")}
          </div>
          {!https ? <HttpsNote /> : null}
          <Steps
            steps={[
              [
                "Add OpenDash to Slack",
                "Slack asks you to approve what OpenDash can do: answer in its Agents tab, direct messages and channels it's mentioned in, read the files people attach, and post its replies.",
              ],
              [
                "People link their account",
                "The first time someone asks, OpenDash sends them a private link to sign in here, with the same email as in Slack, so they ask as themselves.",
              ],
              [
                "It answers where it's asked",
                "In its Agents tab and direct messages, and in a channel's thread when someone mentions it.",
              ],
            ]}
          />
        </section>
      )}

      <section aria-labelledby="slack-files" className="flex flex-col gap-2">
        <h2 id="slack-files" className="text-body font-semibold">
          Files
        </h2>
        <div className="flex flex-col divide-y divide-border rounded-2xl border border-border">
          <div className="flex items-start gap-3 px-4 py-3">
            <FileInput className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
            <div className="flex flex-col gap-0.5">
              <span className="text-body">People can attach text and Markdown files</span>
              <span className="text-small text-muted-tertiary">
                Up to 1 MB each. Read as data, never run; anything inside a file is never followed as an instruction.
              </span>
            </div>
          </div>
          <div className="flex items-start gap-3 px-4 py-3">
            <FileOutput className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
            <div className="flex flex-col gap-0.5">
              <span className="text-body">Answers attach their queries' rows</span>
              <span className="text-small text-muted-tertiary">
                Each cited query's rows as CSV, as its card shows them here. OpenDash never returns personal-data
                columns, so none is in them.
              </span>
            </div>
          </div>
        </div>
        <p className="text-small text-muted-tertiary">
          Questions from Slack count toward your workspace's usage and spend limits, like any other.
        </p>
      </section>

      <AlertDialog>
        <AlertDialog.Backdrop isOpen={disconnecting} onOpenChange={setDisconnecting}>
          <AlertDialog.Container>
            <AlertDialog.Dialog>
              <AlertDialog.Header>
                <AlertDialog.Heading>Disconnect {workspace?.teamName ?? "Slack"}?</AlertDialog.Heading>
              </AlertDialog.Header>
              <AlertDialog.Body>
                <p className="text-body text-muted">
                  OpenDash stops answering there, and everyone's link goes. Conversations asked from Slack stay here.
                </p>
              </AlertDialog.Body>
              <AlertDialog.Footer>
                <Button variant="ghost" slot="close">
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  isPending={pending === "disconnect"}
                  onPress={() =>
                    void run("disconnect", disconnectSlackAction, "Slack is disconnected.").then(() =>
                      setDisconnecting(false),
                    )
                  }
                >
                  Disconnect
                </Button>
              </AlertDialog.Footer>
            </AlertDialog.Dialog>
          </AlertDialog.Container>
        </AlertDialog.Backdrop>
      </AlertDialog>
    </div>
  );
}

/** Slack only calls an https address: locally, a tunnel to the web app. */
function HttpsNote() {
  return (
    <p className="rounded-lg bg-surface-secondary px-3 py-2 text-small text-muted">
      Slack only calls an https address. Locally, start a tunnel to the web app (pnpm slack:tunnel prints its address),
      set SLACK_PUBLIC_URL to it in .env.local, and restart the web app.
    </p>
  );
}

function Steps({ steps }: { steps: [string, string][] }) {
  return (
    <ol className="flex flex-col gap-3 border-t border-border pt-4">
      {steps.map(([title, detail], i) => (
        <li key={title} className="flex gap-3">
          <span className="flex size-5.5 shrink-0 items-center justify-center rounded-full bg-default text-small font-semibold">
            {i + 1}
          </span>
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-body font-medium">{title}</span>
            <span className="break-words text-small text-muted-tertiary">{detail}</span>
          </div>
        </li>
      ))}
    </ol>
  );
}

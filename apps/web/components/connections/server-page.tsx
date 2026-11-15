"use client";

import {
  Alert,
  Button,
  Chip,
  Label,
  Popover,
  Skeleton,
  Switch,
  ToggleButton,
  ToggleButtonGroup,
  toast,
} from "@heroui/react";
import type { mcp } from "@opendash/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Pause, Play, Plug, RefreshCw, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactNode, useState } from "react";
import { api, apiQueries } from "@/lib/api";
import { shortDateTime } from "@/lib/format";
import { keyHeaderLine } from "@/lib/key-header";
import { serverStatus } from "./connections-settings";
import { KeyDialog } from "./key-dialog";
import { AccessTag, AuthTag, announce, mcpMessage, ServerGlyph, useReturnedSignIn, useSignIn } from "./shared";

const TIERS: { id: mcp.ToolView["tier"]; label: string }[] = [
  { id: "always", label: "Always" },
  { id: "ask", label: "Ask first" },
  { id: "blocked", label: "Blocked" },
];

function Card({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5 rounded-2xl border border-border p-4">
      <div className="flex items-center gap-2">
        <h2 className="min-w-0 flex-1 text-small font-semibold">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Line({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 text-small">
      <span className="w-24 shrink-0 text-muted">{k}</span>
      <span className="min-w-0 flex-1 wrap-anywhere">{children}</span>
    </div>
  );
}

const hostOf = (url: string | null) => {
  try {
    return url ? new URL(url).host : null;
  } catch {
    return url;
  }
};

/** A tool's row: what it says it does, whether it reads, when the analyst may use it, and whether dashboards may. */
function ToolRow({
  tool,
  serverDashboardsAllowed,
  ownAccounts,
  onChange,
}: {
  tool: mcp.ToolView;
  serverDashboardsAllowed: boolean;
  /** Each person connects their own account: a tool that changes things may be a dashboard row's button. */
  ownAccounts: boolean;
  onChange: (patch: { tier?: mcp.ToolView["tier"]; dashboardsAllowed?: boolean; reviewed?: true }) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const run = async (patch: Parameters<typeof onChange>[0]) => {
    setBusy(true);
    try {
      await onChange(patch);
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-3 last:border-b-0 @3xl/page:flex-nowrap">
      <div className="flex min-w-0 flex-1 basis-48 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="font-mono text-small font-medium">{tool.name}</span>
          <Chip size="sm" variant="soft" color={tool.readOnly ? "default" : "warning"} className="whitespace-nowrap">
            {tool.readOnly ? "Reads" : "Changes things"}
          </Chip>
          {tool.status === "changed" ? (
            <Chip size="sm" variant="soft" color="warning">
              Changed
            </Chip>
          ) : null}
        </span>
        {tool.description ? (
          <span className="line-clamp-2 text-micro text-muted" title={tool.description}>
            {tool.description}
          </span>
        ) : null}
      </div>
      <ToggleButtonGroup
        className="shrink-0"
        aria-label={`When the analyst uses ${tool.name}`}
        selectionMode="single"
        disallowEmptySelection
        size="sm"
        isDisabled={busy}
        selectedKeys={new Set([tool.tier])}
        onSelectionChange={(keys) => {
          const next = [...keys][0] as mcp.ToolView["tier"] | undefined;
          if (next && next !== tool.tier) void run({ tier: next });
        }}
      >
        {TIERS.map((t, i) => (
          <ToggleButton key={t.id} id={t.id}>
            {i ? <ToggleButtonGroup.Separator /> : null}
            {t.label}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
      <span className="flex w-32 shrink-0 items-center justify-end">
        {serverDashboardsAllowed && (tool.readOnly || ownAccounts) ? (
          // A tool that reads is read by dashboards; one that changes things is a list's row button, confirmed by the
          // person pressing it with their own account.
          <Switch
            size="sm"
            isSelected={tool.dashboardsAllowed}
            isDisabled={busy || tool.status === "changed"}
            onChange={(v) => void run({ dashboardsAllowed: v })}
          >
            <Switch.Content>
              <Label
                className="whitespace-nowrap text-micro text-muted"
                title={
                  tool.readOnly
                    ? "Dashboards may read with it"
                    : "Dashboards may offer it as a row's button: each press is confirmed, with the person's own account"
                }
              >
                {tool.readOnly ? "Dashboards" : "Row buttons"}
              </Label>
              <Switch.Control>
                <Switch.Thumb />
              </Switch.Control>
            </Switch.Content>
          </Switch>
        ) : (
          <span
            className="text-micro text-muted-tertiary"
            title={
              !serverDashboardsAllowed
                ? "Turn on Dashboards may use it first"
                : "Changes are made with each person's own account: this server uses one account for everyone"
            }
          >
            {tool.readOnly || serverDashboardsAllowed ? "Off for dashboards" : "Not in dashboards"}
          </span>
        )}
      </span>
      {tool.status === "changed" ? (
        <Button size="sm" variant="outline" isPending={busy} onPress={() => void run({ reviewed: true })}>
          Accept the change
        </Button>
      ) : null}
    </li>
  );
}

/**
 * A server's page: how it signs in, whose account it uses, the people connected (counts), its
 * tools and what each may do, and what's wrong. Test lists its tools again; Check sign-in again re-runs detection.
 */
export function ServerPage({ serverId }: { serverId: string }) {
  useReturnedSignIn();
  const router = useRouter();
  const queryClient = useQueryClient();
  const server = useQuery(apiQueries.mcp.server.queryOptions({ input: { serverId } }));
  const [busy, setBusy] = useState<string | null>(null);
  const [keyOpen, setKeyOpen] = useState(false);
  const [moved, setMoved] = useState<string | null>(null);
  const signIn = useSignIn((r) => {
    announce(r);
    if (r.state === "ready" && r.serverId === serverId) void test(true);
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: apiQueries.mcp.key() });

  const act = async (label: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(label);
    try {
      await fn();
      if (done) toast.success(done);
    } catch (e) {
      toast.danger(mcpMessage(e, "That didn't work. Try again."));
    } finally {
      setBusy(null);
      await refresh();
    }
  };

  const test = (quiet = false) =>
    act("test", async () => {
      const listed = await api.mcp.listTools({ serverId });
      if (listed.state !== "ready") {
        const words: Record<string, string> = {
          connect: "Connect an account first: its tools are listed through one.",
          reconnect: "The account needs to sign in again (or a new key) before its tools can be listed.",
          wrong_account: "The account signed in as someone else: sign in again.",
          rate_limited: "It asked OpenDash to slow down. Try again in a minute.",
        };
        throw new Error(words[listed.state] ?? ("message" in listed ? String(listed.message) : "It couldn't list."));
      }
      if (!quiet) {
        const changes = listed.added.length + listed.changed.length + listed.removed.length;
        toast.success(
          changes
            ? `Listed: ${listed.added.length} new, ${listed.changed.length} changed, ${listed.removed.length} gone.`
            : "Its tools are as they were.",
        );
      }
    });

  const recheck = (s: mcp.ServerDetail) =>
    act("recheck", async () => {
      const found = await api.mcp.detect({ url: s.url });
      if (found.auth.kind !== s.auth) {
        setMoved(
          `It now ${found.auth.kind === "oauth" ? "signs in with OAuth" : found.auth.kind === "apikey" ? "takes an API key" : "needs no sign-in"}. Remove it and add it again to switch.`,
        );
        return;
      }
      if (found.auth.kind === "oauth" && s.issuer && found.auth.issuer && found.auth.issuer !== s.issuer) {
        setMoved(`It now signs in at ${hostOf(found.auth.issuer)}, not ${hostOf(s.issuer)}.`);
        return;
      }
      setMoved(null);
      if (found.transport !== s.transport) await api.mcp.update({ serverId, transport: found.transport });
      toast.success("It signs in as before.");
    });

  if (server.error) {
    return <p className="text-body text-muted">{mcpMessage(server.error, "That server isn't approved here.")}</p>;
  }
  const s = server.data;
  if (!s) return <Skeleton className="h-96 rounded-2xl" />;
  // Tools dashboards may use now, and those that only read and are still off (blocked or changed ones aren't offered).
  const forDashboards = s.tools_.filter((t) => t.dashboardsAllowed).length;
  const readsOff = s.tools_.filter(
    (t) => t.readOnly && !t.dashboardsAllowed && t.tier !== "blocked" && t.status !== "changed",
  );
  const status = serverStatus(s);
  const own = s.access === "personal" ? s.mine : s.shared;
  const signsIn = s.auth !== "none";
  const ownLabel = s.access === "personal" ? "Your own account" : "The account everyone uses";

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <ServerGlyph name={s.name} host={s.host} size="lg" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-center gap-2">
            <h1 className="text-display">{s.name}</h1>
            <Chip size="sm" variant="soft" color={status.tone}>
              {status.label}
            </Chip>
          </span>
          <span className="truncate font-mono text-micro text-muted-tertiary">
            {s.url} · {s.transport === "sse" ? "HTTP with server-sent events" : "streamable HTTP"}
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" isPending={busy === "test"} onPress={() => void test()}>
            <Plug className="size-3.5" aria-hidden />
            Test
          </Button>
          <Button size="sm" variant="outline" isPending={busy === "recheck"} onPress={() => void recheck(s)}>
            <RefreshCw className="size-3.5" aria-hidden />
            Check sign-in again
          </Button>
          <Button
            size="sm"
            variant="outline"
            isPending={busy === "status"}
            onPress={() =>
              void act(
                "status",
                () => api.mcp.update({ serverId, status: s.status === "active" ? "disabled" : "active" }),
                s.status === "active" ? `${s.name} is off: nothing calls it.` : `${s.name} is on.`,
              )
            }
          >
            {s.status === "active" ? (
              <Pause className="size-3.5" aria-hidden />
            ) : (
              <Play className="size-3.5" aria-hidden />
            )}
            {s.status === "active" ? "Turn off" : "Turn on"}
          </Button>
          <Popover>
            <Button size="sm" variant="outline">
              <Trash2 className="size-3.5" aria-hidden />
              Remove
            </Button>
            <Popover.Content placement="bottom end" className="w-80">
              <Popover.Dialog className="flex flex-col gap-3 p-3">
                <Popover.Heading className="text-small font-medium">Remove {s.name}?</Popover.Heading>
                <p className="text-small text-muted">
                  Everyone's connection to it goes too, with their keys and sign-ins. Dashboards that use it show
                  nothing until it's added again.
                </p>
                <Button
                  size="sm"
                  variant="danger"
                  isPending={busy === "remove"}
                  onPress={() =>
                    void act(
                      "remove",
                      async () => {
                        await api.mcp.remove({ serverId });
                        router.push("/settings/connections");
                      },
                      `${s.name} removed.`,
                    )
                  }
                >
                  Remove it
                </Button>
              </Popover.Dialog>
            </Popover.Content>
          </Popover>
        </div>
      </div>

      {moved ? (
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>It signs in differently now</Alert.Title>
            <Alert.Description>{moved}</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
      {s.tools.changed ? (
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>
              {s.tools.changed} {s.tools.changed === 1 ? "tool changed" : "tools changed"} since it was reviewed
            </Alert.Title>
            <Alert.Description>
              Until you accept the change, the analyst asks before using it, and dashboards don't.
            </Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}

      <div className="flex flex-col gap-4 @4xl/page:flex-row @4xl/page:items-start">
        <section className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border">
          <div className="flex flex-wrap items-baseline gap-2 border-b border-border px-4 py-3">
            <h2 className="text-small font-semibold">Tools</h2>
            <span className="text-micro text-muted">
              {s.toolsListedAt
                ? `${s.tools.total} · ${s.tools.always} run freely · ${s.tools.ask} ask first · ${s.tools.blocked} blocked${s.dashboardsAllowed ? ` · ${forDashboards} for dashboards` : ""} · listed ${shortDateTime(new Date(s.toolsListedAt).toISOString())}`
                : "Not listed yet: they're listed through an account"}
            </span>
          </div>
          {s.tools_.length ? (
            <ul className="flex flex-col">
              {s.tools_.map((t) => (
                <ToolRow
                  key={t.name}
                  tool={t}
                  serverDashboardsAllowed={s.dashboardsAllowed}
                  ownAccounts={s.access === "personal" && s.auth !== "none"}
                  onChange={(patch) =>
                    act(`tool:${t.name}`, () => api.mcp.setTool({ serverId, name: t.name, ...patch }))
                  }
                />
              ))}
            </ul>
          ) : (
            <p className="px-4 py-10 text-center text-small text-muted">
              {signsIn && !own
                ? `Connect ${s.access === "personal" ? "your own account" : "the account everyone uses"} (on the right), then press Test.`
                : "Press Test to list them."}
            </p>
          )}
          <p className="border-t border-border px-4 py-2.5 text-micro text-muted-tertiary">
            A tool the server says only reads starts as Always; any other asks first. Blocked is yours to choose.
          </p>
        </section>

        <div className="flex w-full shrink-0 flex-col gap-3 @4xl/page:w-72">
          <Card title="Sign-in" aside={<AuthTag auth={s.auth} />}>
            {s.auth === "oauth" ? (
              <>
                <Line k="Through">{hostOf(s.issuer) ?? "found on the first sign-in"}</Line>
                <Line k="Client">{s.clientEntered ? "entered by an admin" : "OpenDash registered itself"}</Line>
              </>
            ) : s.auth === "apikey" ? (
              <>
                <Line k="Goes in">
                  <code className="font-mono text-micro">{keyHeaderLine(s.keyHeader, s.keyFormat)}</code>
                </Line>
                {s.keyHint ? <Line k="People find it">{s.keyHint}</Line> : null}
              </>
            ) : (
              <p className="text-small text-muted">Anyone who can use it here sees the same data.</p>
            )}
          </Card>

          <Card title="Whose account" aside={<AccessTag access={s.access} />}>
            {s.access === "personal" && s.people ? (
              <Line k="People">
                {s.people.connected} connected
                {s.people.attention ? ` · ${s.people.attention} need to sign in again` : ""}
              </Line>
            ) : null}
            {s.auth !== "none" ? (
              <Button
                size="sm"
                variant="ghost"
                className="w-fit"
                isPending={busy === "access"}
                onPress={() =>
                  void act(
                    "access",
                    () => api.mcp.update({ serverId, access: s.access === "personal" ? "shared" : "personal" }),
                    s.access === "personal"
                      ? "Now one account for everyone. Connect it below."
                      : "Now each person's own. People connect theirs in My connections.",
                  )
                }
              >
                {s.access === "personal" ? "Switch to one account for everyone" : "Switch to each person's own"}
              </Button>
            ) : null}
            <Switch
              size="sm"
              isSelected={s.dashboardsAllowed}
              onChange={(v) => void act("dashboards", () => api.mcp.update({ serverId, dashboardsAllowed: v }))}
            >
              <Switch.Content>
                <Label className="text-small">Dashboards may use it</Label>
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
              </Switch.Content>
            </Switch>
            {s.dashboardsAllowed ? (
              // On for the server, each tool is still its own choice: say so, and offer the reading ones at once.
              <div className="flex flex-col gap-1.5">
                <p className="text-micro text-muted">
                  {forDashboards
                    ? `${forDashboards} of its ${s.tools_.length} tools ${forDashboards === 1 ? "is" : "are"} on for dashboards (each one's switch is in Tools).`
                    : "No tool is on for dashboards yet: each tool has its own switch in Tools."}
                </p>
                {readsOff.length ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-fit"
                    isPending={busy === "dashboard-reads"}
                    onPress={() =>
                      void act(
                        "dashboard-reads",
                        async () => {
                          for (const t of readsOff) {
                            await api.mcp.setTool({ serverId, name: t.name, dashboardsAllowed: true });
                          }
                        },
                        `${readsOff.length} ${readsOff.length === 1 ? "tool that only reads is" : "tools that only read are"} on for dashboards.`,
                      )
                    }
                  >
                    Turn on the {readsOff.length} {readsOff.length === 1 ? "tool" : "tools"} that only read
                  </Button>
                ) : null}
              </div>
            ) : (
              <p className="text-micro text-muted">Then each of its tools is turned on for dashboards in Tools.</p>
            )}
          </Card>

          {signsIn ? (
            <Card title={ownLabel}>
              {own ? (
                <>
                  <Line k={s.auth === "apikey" ? "Key" : "Account"}>{own.account ?? "connected"}</Line>
                  <Line k="Since">{shortDateTime(new Date(own.connectedAt).toISOString())}</Line>
                  {own.status !== "ready" ? (
                    <p className="text-small text-danger">{own.message ?? "It needs to connect again."}</p>
                  ) : s.auth === "oauth" ? (
                    <p className="text-micro text-muted-tertiary">Switch account disconnects this one first.</p>
                  ) : null}
                </>
              ) : (
                <p className="text-small text-muted">
                  {s.access === "personal"
                    ? "Connect your own, so its tools can be listed and you can use it."
                    : "Not connected: nobody's calls can run until it is."}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                {s.auth === "apikey" ? (
                  <Button size="sm" variant={own ? "outline" : "primary"} onPress={() => setKeyOpen(true)}>
                    {own ? "Replace key" : "Add key"}
                  </Button>
                ) : own?.status === "ready" ? (
                  <Button
                    size="sm"
                    variant="outline"
                    isPending={signIn.pending === serverId}
                    onPress={() => void signIn.start(serverId, { replace: true })}
                  >
                    Switch account
                  </Button>
                ) : (
                  <>
                    <Button
                      size="sm"
                      isPending={signIn.pending === serverId}
                      onPress={() => void signIn.start(serverId)}
                    >
                      {own ? "Sign in again" : "Sign in"}
                    </Button>
                    {own?.status === "wrong_account" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        isDisabled={signIn.pending === serverId}
                        onPress={() => void signIn.start(serverId, { replace: true })}
                      >
                        Switch to the new account
                      </Button>
                    ) : null}
                  </>
                )}
                {own ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    isPending={busy === "disconnect"}
                    onPress={() => void act("disconnect", () => api.mcp.disconnect({ serverId }), "Disconnected.")}
                  >
                    Disconnect
                  </Button>
                ) : null}
              </div>
            </Card>
          ) : null}
        </div>
      </div>
      {keyOpen ? (
        <KeyDialog
          server={{ id: s.id, name: s.name, keyHint: s.keyHint }}
          shared={s.access === "shared"}
          replacing={!!own}
          onClose={() => setKeyOpen(false)}
        />
      ) : null}
    </>
  );
}

"use client";

import { Button, Chip, Skeleton, toast } from "@heroui/react";
import type { mcp } from "@opendash/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, RefreshCw } from "lucide-react";
import { type ReactNode, useState } from "react";
import { api, apiQueries } from "@/lib/api";
import { shortDate } from "@/lib/format";
import { KeyDialog } from "./key-dialog";
import { AuthTag, announce, mcpMessage, ServerGlyph, useReturnedSignIn, useSignIn } from "./shared";

function Group({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <h2 className="text-small font-semibold">{title}</h2>
        {note ? <span className="text-micro text-muted">{note}</span> : null}
      </div>
      <ul className="flex flex-col overflow-hidden rounded-2xl border border-border">{children}</ul>
    </section>
  );
}

function Row({
  c,
  status,
  line,
  actions,
}: {
  c: mcp.MyConnection;
  status?: ReactNode;
  line: string;
  actions?: ReactNode;
}) {
  return (
    <li className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3 last:border-b-0">
      <ServerGlyph name={c.name} host={c.host} />
      <div className="flex min-w-0 flex-1 basis-56 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-small font-semibold">{c.name}</span>
          <AuthTag auth={c.auth} />
          {status}
        </span>
        <span className="text-micro text-muted">{line}</span>
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </li>
  );
}

/**
 * Settings → My connections: what needs the person first (an expired sign-in, a different account, a
 * refused key), then their own, then the ones they haven't connected, then what admins share with everyone.
 */
export function MyConnections() {
  useReturnedSignIn();
  const queryClient = useQueryClient();
  const mine = useQuery(apiQueries.mcp.mine.queryOptions());
  const signIn = useSignIn(announce);
  const [keyFor, setKeyFor] = useState<mcp.MyConnection | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const disconnect = async (c: mcp.MyConnection) => {
    setBusy(c.id);
    try {
      await api.mcp.disconnect({ serverId: c.id });
      toast.success(`${c.name} disconnected.`);
    } catch (e) {
      toast.danger(mcpMessage(e, "Couldn't disconnect. Try again."));
    } finally {
      setBusy(null);
      await queryClient.invalidateQueries({ queryKey: apiQueries.mcp.key() });
    }
  };

  if (!mine.data) return <Skeleton className="h-96 rounded-2xl" />;
  const personal = mine.data.filter((c) => c.access === "personal");
  const needs = personal.filter((c) => c.mine && c.mine.status !== "ready");
  const yours = personal.filter((c) => c.mine?.status === "ready");
  const notYet = personal.filter((c) => !c.mine);
  const shared = mine.data.filter((c) => c.access === "shared");

  const connect = (c: mcp.MyConnection, again = false) =>
    c.auth === "apikey" ? (
      <Button size="sm" variant={again ? "primary" : "outline"} onPress={() => setKeyFor(c)}>
        <KeyRound className="size-3.5" aria-hidden />
        {again ? "Add a new key" : "Add your key"}
      </Button>
    ) : (
      <Button
        size="sm"
        variant={again ? "primary" : "outline"}
        isPending={signIn.pending === c.id}
        onPress={() => void signIn.start(c.id)}
      >
        {again ? <RefreshCw className="size-3.5" aria-hidden /> : null}
        {again ? "Reconnect" : "Connect"}
      </Button>
    );
  const disconnectButton = (c: mcp.MyConnection) => (
    <Button size="sm" variant="ghost" isPending={busy === c.id} onPress={() => void disconnect(c)}>
      {c.auth === "apikey" ? "Remove" : "Disconnect"}
    </Button>
  );

  return (
    <>
      <div className="flex flex-col gap-1.5">
        <h1 className="text-display">My connections</h1>
        <p className="max-w-reading text-body text-muted">
          Services the analyst and dashboards use as you. Only you can use these. Admins see how many people are
          connected, never who, or what you see.
        </p>
      </div>
      {!mine.data.length ? (
        <div className="rounded-2xl border border-border px-6 py-12 text-center text-small text-muted">
          No services are set up here yet. An admin adds them in Settings → Connections.
        </div>
      ) : null}
      {needs.length ? (
        <Group title="Needs you" note={String(needs.length)}>
          {needs.map((c) => (
            <Row
              key={c.id}
              c={c}
              status={
                <Chip size="sm" variant="soft" color="warning">
                  {c.mine?.status === "wrong_account"
                    ? "Different account"
                    : c.auth === "apikey"
                      ? "Key refused"
                      : "Sign in again"}
                </Chip>
              }
              line={
                c.mine?.status === "wrong_account"
                  ? `${c.mine.message ?? "You signed in as a different account."} Nothing reads ${c.name} as you until you choose.`
                  : (c.mine?.message ?? `Nothing reads ${c.name} as you until you connect again.`)
              }
              actions={
                <>
                  {connect(c, true)}
                  {c.mine?.status === "wrong_account" && c.auth === "oauth" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      isDisabled={signIn.pending === c.id}
                      onPress={() => void signIn.start(c.id, { replace: true })}
                    >
                      Switch to the new account
                    </Button>
                  ) : null}
                  {disconnectButton(c)}
                </>
              }
            />
          ))}
        </Group>
      ) : null}
      {yours.length ? (
        <Group title="Yours" note={String(yours.length)}>
          {yours.map((c) => (
            <Row
              key={c.id}
              c={c}
              status={
                <Chip size="sm" variant="soft" color="success">
                  Connected
                </Chip>
              }
              line={[
                c.auth === "apikey"
                  ? `Your key ${c.mine?.account ?? ""}`
                  : c.mine?.account
                    ? `As ${c.mine.account}`
                    : null,
                c.mine ? `since ${shortDate(new Date(c.mine.connectedAt).toISOString())}` : null,
                `${c.tools} tools`,
              ]
                .filter(Boolean)
                .join(" · ")}
              actions={
                <>
                  {c.auth === "apikey" ? (
                    <Button size="sm" variant="outline" onPress={() => setKeyFor(c)}>
                      Replace key
                    </Button>
                  ) : null}
                  {disconnectButton(c)}
                </>
              }
            />
          ))}
        </Group>
      ) : null}
      {notYet.length ? (
        <Group title="Not connected yet" note={String(notYet.length)}>
          {notYet.map((c) => (
            <Row
              key={c.id}
              c={c}
              line={
                c.auth === "apikey"
                  ? `Each person adds their own key. ${c.tools} tools.`
                  : `Each person signs in with their own account. ${c.tools} tools.`
              }
              actions={connect(c)}
            />
          ))}
        </Group>
      ) : null}
      {shared.length ? (
        <Group title="Shared with everyone" note="set up by admins; you can't change these">
          {shared.map((c) => (
            <Row
              key={c.id}
              c={c}
              line={
                c.auth === "none"
                  ? "No sign-in: everyone sees the same data"
                  : c.shared
                    ? `One ${c.auth === "apikey" ? "key" : "account"} for everyone${c.shared.account ? `: ${c.shared.account}` : ""}`
                    : "Not connected yet: an admin has to"
              }
              actions={<span className="text-micro text-muted-tertiary">Managed by admins</span>}
            />
          ))}
        </Group>
      ) : null}
      {keyFor ? (
        <KeyDialog
          server={{ id: keyFor.id, name: keyFor.name, keyHint: keyFor.keyHint }}
          shared={false}
          replacing={!!keyFor.mine}
          onClose={() => setKeyFor(null)}
        />
      ) : null}
    </>
  );
}

"use client";

import { Button } from "@heroui/react";
import type { mcp } from "@opendash/core";
import { useQuery } from "@tanstack/react-query";
import { KeyRound, ShieldQuestion } from "lucide-react";
import { useState } from "react";
import { KeyDialog } from "@/components/connections/key-dialog";
import { announce, ServerGlyph, useSignIn } from "@/components/connections/shared";
import { apiQueries } from "@/lib/api";

/** What the buttons send as the person's next message: the analyst's mcp_call checks these words (core cards.ts). */
const ALLOW_ONCE = "Allow once";
const NOT_NOW = "Not now";

/**
 * A run that needs the person: connect a service so the analyst can read it as them, or allow
 * one call of a tool that asks first. Pressing it sends their answer, which starts the next run; only the latest
 * run's card can be pressed.
 */
export function McpCard({
  outcome,
  can,
  onAsk,
}: {
  outcome: mcp.McpCardOutcome;
  can: boolean;
  onAsk?: (text: string) => void;
}) {
  return outcome.kind === "mcp_connect" ? (
    <ConnectCard card={outcome} can={can} {...(onAsk ? { onAsk } : {})} />
  ) : (
    <ConsentCard card={outcome} can={can} {...(onAsk ? { onAsk } : {})} />
  );
}

function Frame({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-border px-4 py-3.5">
      <div className="flex items-center gap-2.5">
        {icon}
        <h3 className="text-body font-semibold">{title}</h3>
      </div>
      {children}
    </section>
  );
}

function ConnectCard({ card, can, onAsk }: { card: mcp.McpConnectCard; can: boolean; onAsk?: (text: string) => void }) {
  const [keyOpen, setKeyOpen] = useState(false);
  const mine = useQuery({ ...apiQueries.mcp.mine.queryOptions(), enabled: keyOpen });
  const carryOn = () => onAsk?.(`I connected ${card.server}. Carry on.`);
  const signIn = useSignIn((result) => {
    announce(result);
    if (result.state === "ready" && result.serverId === card.serverId) carryOn();
  });
  // An admin connecting a shared server connects the account everyone's questions read: said, never "yours".
  const shared = card.scope === "org";
  const title = shared
    ? card.state === "connect"
      ? `${card.server} needs the account everyone uses`
      : `${card.server}'s shared account has to sign in again`
    : card.state === "connect"
      ? `This needs your ${card.server} account`
      : card.state === "reconnect"
        ? `Your ${card.server} sign-in has to be done again`
        : `${card.server}: a different account`;
  const explain = shared
    ? `${card.server} uses one account for everyone here. As an admin you can connect it; everyone's questions will read what that account can see.`
    : card.state === "connect"
      ? `${card.server} is each person's own here, so the analyst reads it as you. You haven't connected it yet.`
      : (card.message ??
        (card.state === "reconnect"
          ? "It expired or was turned down."
          : "You signed in as a different account than the one connected."));
  const hint = mine.data?.find((c) => c.id === card.serverId)?.keyHint ?? null;
  return (
    <Frame icon={<ServerGlyph name={card.server} host={card.host} size="sm" />} title={title}>
      <p className="text-small text-muted">{explain}</p>
      {can && onAsk ? (
        <div className="flex flex-wrap items-center gap-2">
          {card.auth === "apikey" ? (
            <Button size="sm" onPress={() => setKeyOpen(true)}>
              <KeyRound className="size-3.5" aria-hidden />
              {shared ? "Add the shared key" : card.state === "connect" ? "Add your key" : "Add a new key"}
            </Button>
          ) : (
            <>
              <Button
                size="sm"
                isPending={signIn.pending === card.serverId}
                onPress={() => void signIn.start(card.serverId)}
              >
                {shared
                  ? "Connect the shared account"
                  : card.state === "connect"
                    ? `Connect ${card.server}`
                    : "Sign in again"}
              </Button>
              {card.state === "wrong_account" ? (
                <Button
                  size="sm"
                  variant="outline"
                  isDisabled={signIn.pending === card.serverId}
                  onPress={() => void signIn.start(card.serverId, { replace: true })}
                >
                  Switch to the new account
                </Button>
              ) : null}
            </>
          )}
          <Button size="sm" variant="ghost" onPress={() => onAsk(`Answer without ${card.server}.`)}>
            Answer without it
          </Button>
        </div>
      ) : null}
      <p className="text-micro text-muted-tertiary">After you connect, the question carries on by itself.</p>
      {keyOpen ? (
        <KeyDialog
          server={{ id: card.serverId, name: card.server, keyHint: hint }}
          shared={shared}
          replacing={card.state !== "connect"}
          onClose={() => setKeyOpen(false)}
          onSaved={carryOn}
        />
      ) : null}
    </Frame>
  );
}

function ConsentCard({ card, can, onAsk }: { card: mcp.McpConsentCard; can: boolean; onAsk?: (text: string) => void }) {
  const shown = JSON.stringify(card.arguments, null, 2);
  return (
    <Frame
      icon={<ShieldQuestion className="size-4 text-muted" aria-hidden />}
      title={`Use ${card.tool} on ${card.server}?`}
    >
      <p className="text-small text-muted">
        {card.reason === "changed"
          ? "It changed since an admin reviewed it, so it asks first. This is exactly what would be sent:"
          : "It asks before each use. This is exactly what would be sent:"}
      </p>
      <pre className="max-h-48 overflow-auto rounded-xl bg-surface-secondary px-3 py-2 font-mono text-micro wrap-anywhere whitespace-pre-wrap">
        {shown === "{}" ? "(no arguments)" : shown}
      </pre>
      {can && onAsk ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onPress={() => onAsk(ALLOW_ONCE)}>
            Allow once
          </Button>
          <Button size="sm" variant="ghost" onPress={() => onAsk(NOT_NOW)}>
            Not now
          </Button>
        </div>
      ) : null}
    </Frame>
  );
}

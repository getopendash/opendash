"use client";

import { Chip, toast } from "@heroui/react";
import { isDefinedError } from "@opendash/api/client";
import type { mcp } from "@opendash/core";
import { brandOfHost } from "@opendash/tokens/brands";
import { BrandTile } from "@opendash/ui";
import { useQueryClient } from "@tanstack/react-query";
import { Key, KeyRound, LockOpen, Users } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { api, apiQueries } from "@/lib/api";

/** A refusal's own words, or the fallback. */
export const mcpMessage = (e: unknown, fallback: string) =>
  isDefinedError(e) ? (e as { message: string }).message : fallback;

/**
 * A server's mark: the service's own on its colour, known by the server's address (Jira at mcp.atlassian.com), else
 * its name's first letter on a quiet tile. Never by the name alone: an admin types it, and a sign-in card mustn't show
 * a brand for an address that isn't that brand's (@opendash/tokens/brands).
 */
export function ServerGlyph({
  name,
  host,
  size = "md",
}: {
  name: string;
  host: string | null | undefined;
  size?: "xs" | "sm" | "md" | "lg";
}) {
  return <BrandTile brand={brandOfHost(host, name)} name={name} size={size} />;
}

const AUTH: Record<mcp.ServerView["auth"], { label: string; icon: typeof Key }> = {
  oauth: { label: "OAuth sign-in", icon: KeyRound },
  apikey: { label: "API key", icon: Key },
  none: { label: "No sign-in", icon: LockOpen },
};

export function AuthTag({ auth }: { auth: mcp.ServerView["auth"] }) {
  const a = AUTH[auth];
  return (
    <Chip size="sm" variant="soft" className="whitespace-nowrap">
      <a.icon className="size-3" aria-hidden />
      {a.label}
    </Chip>
  );
}

export function AccessTag({ access }: { access: mcp.ServerView["access"] }) {
  return access === "personal" ? (
    <Chip size="sm" variant="soft" color="accent" className="whitespace-nowrap">
      Each person's own
    </Chip>
  ) : (
    <Chip size="sm" variant="soft" className="whitespace-nowrap">
      <Users className="size-3" aria-hidden />
      One for everyone
    </Chip>
  );
}

/** What a finished sign-in tells the page that started it (from /api/mcp/callback). */
export type SignInResult =
  | { type: "opendash:mcp"; state: "ready"; serverId: string; name: string; account: string | null }
  | { type: "opendash:mcp"; state: "wrong_account"; serverId: string; name: string; account: string | null }
  | { type: "opendash:mcp"; state: "problem"; serverId: null; message: string };

/** Says how a sign-in ended, in a toast. */
export function announce(result: SignInResult) {
  if (result.state === "ready") {
    toast.success(result.account ? `Connected ${result.name} as ${result.account}.` : `Connected ${result.name}.`);
  } else if (result.state === "wrong_account") {
    toast.warning(`${result.name}: you signed in as a different account. Nothing was changed.`);
  } else toast.danger(result.message);
}

/**
 * Signing in to a server: OpenDash asks where to send the person, and the sign-in opens in a window (opened at once,
 * on the press, so it isn't blocked). The window loses its link back to OpenDash before it goes to the service (so the
 * service's page can't navigate this tab), and OpenDash closes it when the result comes back over a
 * BroadcastChannel; every MCP view refreshes and `onDone` hears it. A window closed early just ends the wait. Only
 * when no window could open at all (blocked) does the whole tab go, coming back to this page.
 * `replace`: sign in as another account; the one connected now is disconnected first.
 */
export function useSignIn(onDone?: (result: SignInResult) => void) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<string | null>(null);
  const done = useRef(onDone);
  done.current = onDone;
  const popupRef = useRef<Window | null>(null);
  const watchRef = useRef<number | null>(null);

  const stopWatching = useCallback(() => {
    if (watchRef.current !== null) window.clearInterval(watchRef.current);
    watchRef.current = null;
  }, []);

  useEffect(() => {
    let channel: BroadcastChannel | null = null;
    try {
      channel = new BroadcastChannel("opendash-mcp");
    } catch {
      return stopWatching;
    }
    channel.onmessage = (event: MessageEvent<SignInResult>) => {
      if (event.data?.type !== "opendash:mcp") return;
      stopWatching();
      popupRef.current?.close();
      popupRef.current = null;
      setPending(null);
      void queryClient.invalidateQueries({ queryKey: apiQueries.mcp.key() });
      done.current?.(event.data);
    };
    return () => {
      channel?.close();
      stopWatching();
    };
  }, [queryClient, stopWatching]);

  const start = useCallback(
    async (serverId: string, options: { replace?: boolean } = {}) => {
      const popup = window.open("", "opendash-mcp", "popup,width=520,height=720");
      popupRef.current = popup;
      setPending(serverId);
      try {
        if (options.replace) {
          await api.mcp.disconnect({ serverId });
          void queryClient.invalidateQueries({ queryKey: apiQueries.mcp.key() });
        }
        const { authorizationUrl } = await api.mcp.connect({ serverId });
        if (popup?.closed) {
          // Closed before it got anywhere: the person changed their mind.
          popupRef.current = null;
          setPending(null);
          return;
        }
        if (popup) {
          // The service's page gets no handle on this tab.
          popup.opener = null;
          popup.location.href = authorizationUrl;
          popup.focus();
          stopWatching();
          watchRef.current = window.setInterval(() => {
            if (!popup.closed) return;
            stopWatching();
            popupRef.current = null;
            setPending((now) => (now === serverId ? null : now));
          }, 600);
        } else {
          try {
            sessionStorage.setItem("opendash-mcp-return", window.location.pathname + window.location.search);
          } catch {}
          window.location.assign(authorizationUrl);
        }
      } catch (e) {
        popup?.close();
        popupRef.current = null;
        setPending(null);
        toast.danger(mcpMessage(e, "Couldn't start signing in. Try again."));
      }
    },
    [queryClient, stopWatching],
  );

  return { start, pending };
}

/** After a sign-in that took the whole tab: say how it went once, then tidy the address. */
export function useReturnedSignIn() {
  const queryClient = useQueryClient();
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const state = params.get("mcp");
    if (!state) return;
    if (state === "ready") toast.success("Connected.");
    else if (state === "wrong_account") toast.warning("You signed in as a different account. Nothing was changed.");
    else toast.danger("That sign-in didn't finish. Try again.");
    params.delete("mcp");
    params.delete("server");
    const rest = params.toString();
    window.history.replaceState(null, "", window.location.pathname + (rest ? `?${rest}` : ""));
    void queryClient.invalidateQueries({ queryKey: apiQueries.mcp.key() });
  }, [queryClient]);
}

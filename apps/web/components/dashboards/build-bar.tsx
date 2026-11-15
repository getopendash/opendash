"use client";

import { Button, Spinner, toast } from "@heroui/react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { shortDuration } from "@/lib/run-steps";
import { useRunFeed } from "./use-run-feed";

const ACTIVE = new Set(["queued", "running", "cancelling"]);

/**
 * While the analyst builds or changes this App (no bar across the page): in the top bar, that it's
 * building, how long, and Stop (its last checked save stays, a draft). The page itself is the progress: a save that
 * lands draws at once. Its owner's only.
 */
export function BuildBar({
  dashboardId,
  runId,
  startedAt,
  shownRevision,
}: {
  dashboardId: string;
  runId: string;
  startedAt: string;
  /** The draft revision the page drew (null for none): the saves up to it are what it already shows. */
  shownRevision: string | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  // The run's events as they come: the page's one read of them, shared with the App's glowing edge. A run this person
  // can't read (not theirs) reads as ended: the bar says it's done, never spins forever.
  const { events, status, loaded } = useRunFeed(runId);
  const [now, setNow] = useState(() => Date.now());
  const [stopping, setStopping] = useState(false);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Its saves of this App, and which passed their check.
  const saves = useMemo(() => {
    const out: { callId: string; done: boolean; ok: boolean; revision?: string }[] = [];
    for (const e of events) {
      const d = e.data as {
        callId?: string;
        tool?: string;
        dashboardId?: string;
        status?: string;
        failed?: boolean;
        revision?: string;
      };
      if (d.tool !== "dashboard_save" || !d.callId) continue;
      if (e.type === "tool_started") out.push({ callId: d.callId, done: false, ok: false });
      else if (e.type === "tool_result") {
        const s = out.find((x) => x.callId === d.callId);
        // A save that passed its check, of this App (a conversation may build more than one).
        const ok = d.status === "succeeded" && !d.failed && d.dashboardId === dashboardId;
        if (s) Object.assign(s, { done: true, ok, ...(d.revision ? { revision: d.revision } : {}) });
      }
    }
    return out;
  }, [events, dashboardId]);
  const landed = saves.filter((s) => s.ok);

  // A save that lands draws at once (the draft). Saves that landed before this bar was here are what the page already draws: only later ones are new.
  const seen = useRef<number | null>(null);
  /** The saves already landed when this bar first heard from the run. */
  const baseline = useRef<number | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: drawn again only when another save lands
  useEffect(() => {
    if (!loaded) return;
    if (seen.current === null) {
      // What the page already shows: the saves up to the one it drew (none of this run's when it drew an older draft);
      // any later one, even one that landed before this first answer, is new.
      const drawn = shownRevision ? landed.findIndex((x) => x.revision === shownRevision) + 1 : 0;
      baseline.current = drawn;
      seen.current = drawn;
      if (landed.length <= drawn) return;
    }
    if (landed.length <= seen.current) return;
    seen.current = landed.length;
    const params = new URLSearchParams(search.toString());
    if (params.get("draft") !== "1") {
      params.set("draft", "1");
      router.replace(`${pathname}?${params.toString()}`);
    }
    router.refresh();
  }, [landed.length, loaded]);

  // Done: the page as it ends.
  const active = ACTIVE.has(status);
  const wasActive = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, when the run stops being active
  useEffect(() => {
    if (wasActive.current && !active) {
      // The draft a save made here stays in view.
      const params = new URLSearchParams(search.toString());
      if (landed.length > (baseline.current ?? landed.length) && params.get("draft") !== "1") {
        params.set("draft", "1");
        router.replace(`${pathname}?${params.toString()}`);
      }
      router.refresh();
    }
    wasActive.current = active;
  }, [active, router]);

  if (!active) return null;
  const stop = async () => {
    setStopping(true);
    try {
      await api.runs.stop({ runId });
    } catch {
      toast.danger("Couldn't stop it.");
      setStopping(false);
    }
  };
  const stoppingNow = status === "cancelling" || stopping;
  return (
    <span className="flex items-center gap-2 text-small text-muted">
      <Spinner size="sm" />
      {/* Said when it changes; the clock ticks beside it, unannounced. */}
      <span role="status">{stoppingNow ? "Stopping: the last checked draft stays" : "Building"}</span>
      {stoppingNow ? null : (
        <span aria-hidden className="tabular-nums">
          {shortDuration(Math.max(0, now - Date.parse(startedAt)))}
        </span>
      )}
      <Button size="sm" variant="tertiary" isDisabled={stoppingNow} onPress={() => void stop()}>
        Stop
      </Button>
    </span>
  );
}

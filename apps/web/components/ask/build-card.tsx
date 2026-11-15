"use client";

import { Button, toast } from "@heroui/react";
import type { RunEvent } from "@opendash/api/client";
import { useQuery } from "@tanstack/react-query";
import { CircleCheck, LayoutDashboard } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { api, apiQueries } from "@/lib/api";
import { shortDuration } from "@/lib/run-steps";

type Page = { id?: string; title: string; sections?: unknown[] };
type PageState = "built" | "writing" | "next" | "unbuilt";

/**
 * A build, in one card at the top of its run: the dashboard, how long and Stop while it works; its
 * plan's pages, each ticked as it lands, the one being written turning; paused, what it spent of the ceiling. Read
 * from the dashboard itself (its plan and draft), so it says the same however the run ended. Its owner's only: a
 * reader of the conversation gets nothing from the dashboard and sees no card.
 */
export function BuildCard({
  dashboardId,
  runId,
  events,
  active,
  status,
  startedAt,
  now,
  paused,
}: {
  dashboardId: string;
  runId: string;
  events: RunEvent[];
  active: boolean;
  status: string;
  startedAt: string | null;
  now: number;
  paused: { spentUsd: number; ceilingUsd: number | null } | null;
}) {
  const d = useQuery({
    ...apiQueries.dashboards.get.queryOptions({ input: { dashboardId } }),
    // While it builds, read again now and then too: a save landing also invalidates it.
    refetchInterval: active ? 5000 : false,
  });
  const [stopping, setStopping] = useState(false);
  if (!d.data?.mine) return null;
  const plan = ((d.data.plan as { pages?: Page[] } | null)?.pages ?? []).filter((p): p is Page & { id: string } =>
    Boolean(p.id),
  );
  const drawn = (d.data.draft?.definition as { pages?: Page[] } | undefined)?.pages ?? [];
  const built = new Map(drawn.map((p) => [p.id, p.sections?.length ?? 0]));
  // The saves being checked now: the page each writes.
  const pending = new Map<string, string | null>();
  for (const e of events) {
    const x = e.data as { tool?: string; callId?: string; input?: { page?: { id?: unknown } } };
    if ((x.tool !== "dashboard_save" && x.tool !== "dashboard_page") || !x.callId) continue;
    if (e.type === "tool_started")
      pending.set(x.callId, typeof x.input?.page?.id === "string" ? x.input.page.id : null);
    else if (e.type === "tool_result") pending.delete(x.callId);
  }
  const writing = new Set(active ? [...pending.values()].filter((v): v is string => v !== null) : []);
  // A whole save being checked writes the pages not built yet.
  const wholeSave = active && [...pending.values()].some((v) => v === null);
  // An App: its files this run wrote, each ticked as its save passes, not pages.
  const files = appFiles(events, active);
  const app = (d.data.draft?.definition as { version?: unknown } | undefined)?.version === 2 || files.length > 0;
  const pages = (app ? [] : plan.length ? plan : drawn.filter((p): p is Page & { id: string } => Boolean(p.id))).map(
    (p) => {
      const state: PageState = writing.has(p.id)
        ? "writing"
        : built.has(p.id)
          ? "built"
          : wholeSave
            ? "writing"
            : active
              ? "next"
              : "unbuilt";
      return { id: p.id, title: p.title, state, sections: built.get(p.id) ?? 0 };
    },
  );
  const stop = async () => {
    setStopping(true);
    try {
      await api.runs.stop({ runId });
    } catch {
      toast.danger("Couldn't stop it.");
      setStopping(false);
    }
  };
  const elapsed = startedAt ? shortDuration(Math.max(0, now - Date.parse(startedAt))) : null;
  const href = `/dashboards/${dashboardId}${d.data.draft?.revision ? "?draft=1" : ""}`;
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border px-3.5 py-3">
      <div className="flex items-center gap-2">
        <LayoutDashboard className="size-4 text-muted" aria-hidden />
        <Link href={href} className="min-w-0 flex-1 truncate font-medium text-body hover:underline">
          {d.data.title}
        </Link>
        <span className="flex shrink-0 items-center gap-2 text-small text-muted tabular-nums">
          {active ? (
            <>
              {stopping || status === "cancelling" ? "Stopping" : elapsed}
              <Button
                size="sm"
                variant="tertiary"
                isDisabled={stopping || status === "cancelling"}
                onPress={() => void stop()}
              >
                Stop
              </Button>
            </>
          ) : paused ? (
            `Paused · $${paused.spentUsd.toFixed(2)}${paused.ceilingUsd !== null ? ` of $${paused.ceilingUsd.toFixed(2)}` : ""}`
          ) : status === "cancelled" ? (
            "Stopped"
          ) : (
              app
                ? files.length > 0 && files.every((f) => f.state === "built")
                : pages.length > 0 && pages.every((p) => p.state === "built")
            ) ? (
            "Built"
          ) : null}
        </span>
      </div>
      {app && files.length ? (
        <ul className="flex flex-col gap-1 ps-6">
          {files.map((f) => (
            <li key={f.path} className="flex items-center gap-2 text-small">
              {/* Written but not built yet is work going on, drawn as next, never as a warning. */}
              <Mark state={f.state === "fixing" ? "next" : f.state} />
              <span className="min-w-0 flex-1 truncate font-mono text-small">{f.path.replace(/^\//, "")}</span>
              <span className={`shrink-0 ${f.state === "writing" ? "text-accent" : "text-muted-tertiary"}`}>
                {f.state === "writing" ? "writing" : f.state === "fixing" ? "written, checking" : f.detail}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {pages.length ? (
        <ul className="flex flex-col gap-1 ps-6">
          {pages.map((p) => (
            <li key={p.id} className="flex items-center gap-2 text-small">
              <Mark state={p.state} />
              <span className={`min-w-0 flex-1 truncate ${p.state === "built" ? "text-foreground" : "text-muted"}`}>
                {p.title}
              </span>
              <span
                className={`shrink-0 ${p.state === "writing" ? "text-accent" : p.state === "unbuilt" ? "text-warning-soft-foreground" : "text-muted-tertiary"}`}
              >
                {p.state === "built"
                  ? `${p.sections} ${p.sections === 1 ? "section" : "sections"}`
                  : p.state === "writing"
                    ? "writing"
                    : p.state === "unbuilt"
                      ? "not built"
                      : ""}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function Mark({ state }: { state: PageState }) {
  if (state === "built") return <CircleCheck className="size-3.5 shrink-0 text-success" aria-label="Built" />;
  if (state === "writing") {
    return (
      <span
        role="img"
        aria-label="Being written"
        className="size-3.5 shrink-0 animate-spin rounded-full border-2 border-accent/30 border-t-accent motion-reduce:animate-none"
      />
    );
  }
  return (
    <span
      role="img"
      aria-label={state === "next" ? "Next" : "Not built"}
      className={`size-3.5 shrink-0 rounded-full border-2 border-dashed ${state === "unbuilt" ? "border-warning" : "border-muted-tertiary"}`}
    />
  );
}

/** The files a run's saves wrote, edited or removed, in the order first touched: done, being written, or being fixed. */
function appFiles(
  events: RunEvent[],
  active: boolean,
): { path: string; state: "built" | "writing" | "fixing"; detail: string }[] {
  const out = new Map<string, { path: string; state: "built" | "writing" | "fixing"; detail: string }>();
  const touched = new Map<string, { path: string; detail: string }[]>();
  for (const e of events) {
    const x = e.data as {
      tool?: string;
      callId?: string;
      status?: string;
      failed?: boolean;
      input?: { files?: Record<string, unknown>; edits?: { file?: unknown; old?: unknown; new?: unknown }[] };
    };
    if (x.tool !== "dashboard_save" || !x.callId) continue;
    if (e.type === "tool_started") {
      const list: { path: string; detail: string }[] = [];
      for (const [path, source] of Object.entries(x.input?.files ?? {})) {
        list.push({ path, detail: typeof source === "string" ? `${source.split("\n").length} lines` : "removed" });
      }
      for (const edit of x.input?.edits ?? []) {
        if (typeof edit?.file !== "string") continue;
        const plus = typeof edit.new === "string" ? edit.new.split("\n").length : 0;
        const minus = typeof edit.old === "string" ? edit.old.split("\n").length : 0;
        list.push({ path: edit.file, detail: `+${plus} −${minus}` });
      }
      touched.set(x.callId, list);
      for (const f of list) out.set(f.path, { ...f, state: active ? "writing" : "fixing" });
    } else if (e.type === "tool_result") {
      const ok = x.status === "succeeded" && !x.failed;
      for (const f of touched.get(x.callId) ?? []) out.set(f.path, { ...f, state: ok ? "built" : "fixing" });
    }
  }
  return [...out.values()];
}

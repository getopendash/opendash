"use client";

import { Button, buttonVariants, toast } from "@heroui/react";
import type { RoutineView } from "@opendash/core";
import { RoutineSentence } from "@opendash/ui";
import { Plus, Repeat } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { leaveRoutineAction } from "@/app/(app)/routines/actions";
import { TopBar } from "@/components/shell/top-bar";
import { answerOf } from "@/lib/action-answer";
import { whenLine } from "@/lib/routine-words";
import { WorkspaceTz } from "./workspace-tz";

/** A routine as the list shows it: the team's (it reaches past its owner) or someone's own. */
export interface RoutineRow {
  routine: RoutineView;
  team: boolean;
  owner: string;
}

const BUSY = new Set(["queued", "running", "writing", "sending"]);

/**
 * Routines (the list): everything that runs on its own, each as its sentence. Team lists the routines
 * that reach past their owner; Yours, every one you own and the team's that also come to you (each with Stop). Someone
 * else's that tell only them are theirs alone: owners and admins see how many there are.
 */
export function RoutinesView({
  rows,
  tab,
  me,
  tz,
  canManage,
  othersPrivate,
}: {
  rows: RoutineRow[];
  tab: "team" | "yours";
  me: string;
  tz: string;
  canManage: boolean;
  /** How many routines other people keep for themselves (owners and admins are told). */
  othersPrivate: number;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  // A run's day where the workspace is, as its times are.
  const day = useMemo(() => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: tz }), [tz]);
  const team = rows.filter((r) => r.team);
  const yours = rows.filter((r) => r.routine.ownerId === me);
  const also = rows.filter((r) => r.team && r.routine.ownerId !== me && r.routine.userIds.includes(me));
  const shown = tab === "team" ? team : [...yours, ...also];
  const stop = async (id: string) => {
    setPending(id);
    const r = await answerOf(() => leaveRoutineAction(id));
    setPending(null);
    if (!r.ok) toast.danger(r.message);
    else toast.success("You won't get it any more.");
    router.refresh();
  };
  return (
    <>
      <TopBar
        crumbs={[{ label: "Routines" }]}
        action={
          <Link href="/routines/new" className={buttonVariants({ size: "sm" })}>
            <Plus className="size-3.5" aria-hidden />
            New routine
          </Link>
        }
      />
      <div className="flex-1 overflow-y-auto px-6 pt-6 pb-16 @2xl/page:px-8">
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-1.5">
            <h1 className="text-display">Routines</h1>
            <p className="max-w-reading text-body text-muted">
              Everything that runs on its own, on a schedule or when something is found: when, what and where. What it
              writes is kept in Reports, and what it finds in Insights.
            </p>
          </div>
          <nav aria-label="Whose" className="flex w-fit items-center gap-0.5 rounded-xl bg-surface-secondary p-0.5">
            {[
              { id: "team", label: `Team · ${team.length}`, href: "/routines" },
              { id: "yours", label: `Yours · ${yours.length + also.length}`, href: "/routines?tab=yours" },
            ].map((t) => (
              <Link
                key={t.id}
                href={t.href}
                aria-current={t.id === tab ? "page" : undefined}
                className={`rounded-lg px-2.5 py-1 text-small ${t.id === tab ? "bg-surface font-medium" : "text-muted hover:text-foreground"}`}
              >
                {t.label}
              </Link>
            ))}
          </nav>
          {shown.length ? (
            <ul className="flex flex-col overflow-hidden rounded-2xl border border-border bg-surface">
              {shown.map(({ routine: r, team: isTeam, owner }) => {
                const alsoYours = isTeam && r.ownerId !== me && tab === "yours";
                const busy = r.lastRun && BUSY.has(r.lastRun.status);
                // One that watches runs only when it tells someone; a paused one says why beside its status.
                const meta = [
                  alsoYours ? "Also sent to you, from a team routine" : null,
                  r.status === "paused"
                    ? r.pausedReason
                    : r.trigger === "found"
                      ? "Checked as its data lands"
                      : r.nextRunAt
                        ? `Next ${whenLine(r.nextRunAt, tz)}`
                        : null,
                  r.lastRun
                    ? `last ${r.trigger === "found" ? "told " : ""}${day.format(new Date(r.lastRun.at))}${r.lastRun.status === "failed" ? ", failed" : ""}`
                    : r.trigger === "found"
                      ? null
                      : "not run yet",
                  isTeam && !alsoYours && tab === "team" ? owner : null,
                ].filter(Boolean);
                return (
                  <li key={r.id} className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0">
                    <Link href={`/routines/${r.id}`} className="flex min-w-0 flex-1 flex-col gap-1 hover:opacity-90">
                      <RoutineSentence parts={r.sentence} />
                      <span className="text-small text-muted">{meta.join(" · ")}</span>
                    </Link>
                    {alsoYours ? (
                      <Button size="sm" variant="ghost" isPending={pending === r.id} onPress={() => void stop(r.id)}>
                        Stop
                      </Button>
                    ) : (
                      <span className="flex shrink-0 items-center gap-1.5 text-small text-muted">
                        <span
                          className={`size-2 rounded-full ${busy ? "bg-accent" : r.status === "active" ? "bg-success" : "bg-default"}`}
                          aria-hidden
                        />
                        {busy ? "Running…" : r.status === "active" ? "On" : "Paused"}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-border px-6 py-14 text-center">
              <Repeat className="size-6 text-muted" aria-hidden />
              <p className="text-lead">{tab === "team" ? "No team routines yet" : "No routines of yours yet"}</p>
              <p className="max-w-reading text-body text-muted">
                {tab === "team"
                  ? "A routine that sends a dashboard to the team, or tells a channel when something is unusual, shows here."
                  : "Email yourself a dashboard every Monday, or ask to be told when a number crosses a line."}
              </p>
              <Link href="/routines/new" className={buttonVariants({ size: "sm" })}>
                <Plus className="size-3.5" aria-hidden />
                New routine
              </Link>
            </div>
          )}
          <p className="text-small text-muted-tertiary">
            {tab === "yours"
              ? "Change your own from their pages. One of the team's that comes to you, stop here or from its email."
              : "Four failed runs in a row pause a routine and tell its owner. Paused routines keep their history."}
          </p>
          {tab === "team" && canManage && othersPrivate > 0 ? (
            <p className="text-small text-muted-tertiary">
              {othersPrivate === 1
                ? "One more routine is someone's own: it tells only them, so only they see it."
                : `${othersPrivate} more routines are people's own: each tells only its owner, so only they see it.`}
            </p>
          ) : null}
          <WorkspaceTz tz={tz} canManage={canManage} />
        </div>
      </div>
    </>
  );
}

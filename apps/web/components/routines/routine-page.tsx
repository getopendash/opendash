"use client";

import { AlertDialog, Button, buttonVariants, ToggleButton, ToggleButtonGroup, toast } from "@heroui/react";
import type { RoutineCheck, RoutineRunView, RoutineView, Sensitivity } from "@opendash/core";
import { RoutineSentence } from "@opendash/ui";
import { CirclePause, CirclePlay, Pencil, Play, RefreshCw, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  deleteRoutineAction,
  leaveRoutineAction,
  runRoutineNowAction,
  setRoutineStatusAction,
  setSensitivityAction,
} from "@/app/(app)/routines/actions";
import { TopBar } from "@/components/shell/top-bar";
import { answerOf } from "@/lib/action-answer";
import { checkLine, type HappensNames, runLine, whatHappens, whenLine } from "@/lib/routine-words";

type Run = RoutineRunView & { insights: { id: string; title: string }[] };

const TONE = {
  ok: "text-foreground",
  bad: "text-danger",
  pending: "text-accent",
  plain: "text-muted",
} as const;

/** A routine's page: its sentence, what it does each time, and its runs (or its checks and runs). */
export function RoutinePage({
  routine: r,
  names,
  owner,
  me,
  tz,
  canManage,
  watching,
}: {
  routine: RoutineView & { runs: Run[]; checks: RoutineCheck[] };
  names: HappensNames;
  owner: string;
  me: string;
  tz: string;
  canManage: boolean;
  watching: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const happens = whatHappens(r.spec, names);
  const found = r.spec.trigger === "found";
  const sensitivity: Sensitivity | null =
    r.spec.trigger === "found" && r.spec.condition.kind === "unusual" ? r.spec.condition.sensitivity : null;
  const onIt = r.userIds.includes(me) && r.ownerId !== me;

  const act = async (
    what: string,
    fn: () => Promise<{ ok: true } | { ok: false; message: string }>,
    done: string,
    /** Where to go once it's done, instead of drawing this page again (a routine deleted or left isn't here to draw). */
    then?: string,
  ) => {
    setPending(what);
    const out = await answerOf(fn);
    setPending(null);
    if (!out.ok) toast.danger(out.message);
    else toast.success(done);
    if (out.ok && then) router.replace(then);
    else router.refresh();
    return out.ok;
  };
  const runNow = async () => {
    setPending("run");
    const out = await answerOf(() => runRoutineNowAction(r.id));
    setPending(null);
    if (!out.ok) toast.danger(out.message);
    else if (out.status === "under_way") toast.info("It's already running.");
    else toast.success(found ? "Checking its metrics now." : "Running now. It shows below as it goes.");
    router.refresh();
  };

  return (
    <>
      <TopBar
        crumbs={[
          { label: "Routines", href: "/routines" },
          { label: r.name ?? (found ? "Tells when found" : "On a schedule") },
        ]}
        action={
          <span className="flex items-center gap-2">
            {r.canEdit && r.status === "active" ? (
              <Button size="sm" variant="outline" isPending={pending === "run"} onPress={() => void runNow()}>
                {found ? <RefreshCw className="size-3.5" aria-hidden /> : <Play className="size-3.5" aria-hidden />}
                {found ? "Check now" : "Run now"}
              </Button>
            ) : null}
            {r.canEdit ? (
              <Link href={`/routines/${r.id}/edit`} className={buttonVariants({ size: "sm", variant: "outline" })}>
                <Pencil className="size-3.5" aria-hidden />
                Edit
              </Link>
            ) : null}
            {r.canEdit ? (
              <Button
                size="sm"
                variant="ghost"
                isPending={pending === "status"}
                onPress={() =>
                  void act(
                    "status",
                    () => setRoutineStatusAction(r.id, r.status === "active" ? "paused" : "active"),
                    r.status === "active" ? "Paused. Nothing runs until you resume it." : "Resumed.",
                  )
                }
              >
                {r.status === "active" ? (
                  <CirclePause className="size-3.5" aria-hidden />
                ) : (
                  <CirclePlay className="size-3.5" aria-hidden />
                )}
                {r.status === "active" ? "Pause" : "Resume"}
              </Button>
            ) : null}
            {r.canEdit && !watching ? (
              <Button
                size="sm"
                variant="ghost"
                aria-label="Delete routine"
                isIconOnly
                onPress={() => setDeleting(true)}
              >
                <Trash2 className="size-3.5" aria-hidden />
              </Button>
            ) : null}
          </span>
        }
      />
      <div className="flex-1 overflow-y-auto px-6 pt-6 pb-16 @2xl/page:px-8">
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <span className="text-small font-medium text-muted">
              {watching
                ? "The workspace's own · what it finds stays in Insights"
                : names.team
                  ? `Team routine · ${owner}`
                  : r.ownerId === me
                    ? "Your routine"
                    : `${owner}'s routine`}
            </span>
            <RoutineSentence parts={r.sentence} size="lg" />
            {onIt ? (
              <span className="flex flex-wrap items-center gap-2 text-small text-muted">
                It's sent to you.
                <Button
                  size="sm"
                  variant="ghost"
                  isPending={pending === "leave"}
                  onPress={() =>
                    void act(
                      "leave",
                      () => leaveRoutineAction(r.id),
                      "You won't get it any more.",
                      "/routines?tab=yours",
                    )
                  }
                >
                  Stop sending it to me
                </Button>
              </span>
            ) : null}
          </div>

          {r.status === "paused" ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-warning-soft px-4 py-3 text-warning-soft-foreground">
              <span className="text-body">
                Paused{r.pausedReason ? `: ${r.pausedReason}` : ". Nothing runs until it's resumed."}
              </span>
              {r.canEdit ? (
                <Button
                  size="sm"
                  isPending={pending === "status"}
                  onPress={() => void act("status", () => setRoutineStatusAction(r.id, "active"), "Resumed.")}
                >
                  Resume
                </Button>
              ) : null}
            </div>
          ) : null}

          <div className="grid gap-4 @4xl/page:grid-cols-5">
            <section className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-5 @4xl/page:col-span-3">
              <h2 className="text-lead">What happens</h2>
              <ol className="flex list-decimal flex-col gap-1.5 ps-5 text-body">
                {happens.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ol>
              <p className="text-small text-muted">{happens.keeps.text}</p>
            </section>
            <section className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-5 @4xl/page:col-span-2">
              <h2 className="text-lead">Next</h2>
              <p className="text-body">
                {r.status === "paused"
                  ? "Nothing, while it's paused."
                  : found
                    ? "Each metric is checked at 06:00 once its period closes, then daily until its data is in."
                    : r.nextRunAt
                      ? whenLine(r.nextRunAt, tz)
                      : "Not scheduled."}
              </p>
              <p className="text-small text-muted">{happens.who}</p>
              {sensitivity && r.canEdit ? (
                <div className="flex flex-col gap-1.5 pt-1">
                  <span className="text-small font-medium">How unusual counts</span>
                  <ToggleButtonGroup
                    aria-label="How unusual counts"
                    selectionMode="single"
                    disallowEmptySelection
                    isDisabled={pending === "sensitivity"}
                    selectedKeys={new Set([sensitivity])}
                    onSelectionChange={(keys) => {
                      const next = [...keys][0] as Sensitivity | undefined;
                      if (next && next !== sensitivity) {
                        void act(
                          "sensitivity",
                          () => setSensitivityAction(r.id, next),
                          "Saved. The next check uses it.",
                        );
                      }
                    }}
                    size="sm"
                    className="w-fit"
                  >
                    <ToggleButton id="lower">Lower</ToggleButton>
                    <ToggleButton id="medium">
                      <ToggleButtonGroup.Separator />
                      Medium
                    </ToggleButton>
                    <ToggleButton id="higher">
                      <ToggleButtonGroup.Separator />
                      Higher
                    </ToggleButton>
                  </ToggleButtonGroup>
                  <span className="text-small text-muted-tertiary">Higher finds more.</span>
                </div>
              ) : null}
            </section>
          </div>

          {found && r.checks.length ? (
            <section className="flex flex-col gap-2">
              <h2 className="text-lead">Checks</h2>
              <ul className="flex flex-col overflow-hidden rounded-2xl border border-border bg-surface">
                {r.checks.map((c) => {
                  const line = checkLine(c, tz);
                  return (
                    <li
                      key={c.metric.id}
                      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-border px-4 py-2.5 last:border-b-0"
                    >
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate text-body">{c.metric.title}</span>
                        <span className={`text-small ${line.problem ? "text-danger" : "text-muted"}`}>{line.text}</span>
                      </span>
                      <span className="text-small text-muted">
                        {c.grain === "month" ? "Monthly" : c.grain === "week" ? "Weekly" : "Not checked"}
                        {c.nextCheckAt && r.status === "active" ? ` · next ${whenLine(c.nextCheckAt, tz)}` : ""}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}

          <section className="flex flex-col gap-2">
            <h2 className="text-lead">{found ? "What it told" : "Runs"}</h2>
            {r.runs.length ? (
              <ul className="flex flex-col overflow-hidden rounded-2xl border border-border bg-surface">
                {r.runs.map((run) => {
                  const line = runLine(run);
                  return (
                    <li
                      key={run.id}
                      className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border px-4 py-2.5 last:border-b-0"
                    >
                      <span className="w-36 shrink-0 text-small text-muted tabular-nums">{whenLine(run.at, tz)}</span>
                      <span className={`min-w-0 flex-1 text-body ${TONE[line.tone]}`}>{line.text}</span>
                      {run.answer ? (
                        <Link href={`/ask/${run.answer.threadId}`} className="text-small text-link hover:underline">
                          Open the answer
                        </Link>
                      ) : run.insights.length ? (
                        <Link href="/insights" className="text-small text-link hover:underline">
                          In Insights
                        </Link>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="rounded-2xl border border-dashed border-border px-4 py-6 text-center text-body text-muted">
                {found
                  ? "Nothing told yet. What it finds shows here, and in Insights."
                  : (happens.first ?? "It hasn't run yet.")}
              </p>
            )}
            {!canManage && names.team ? (
              <p className="text-small text-muted-tertiary">Owners and admins change team routines.</p>
            ) : null}
          </section>
        </div>
      </div>
      <AlertDialog>
        <AlertDialog.Backdrop isOpen={deleting} onOpenChange={setDeleting}>
          <AlertDialog.Container>
            <AlertDialog.Dialog>
              <AlertDialog.Header>
                <AlertDialog.Heading>Delete this routine?</AlertDialog.Heading>
              </AlertDialog.Header>
              <AlertDialog.Body>
                <p className="text-body text-muted">
                  It stops for everyone it reaches. The reports it wrote stay in Reports, and what it found stays in
                  Insights.
                </p>
              </AlertDialog.Body>
              <AlertDialog.Footer>
                <Button variant="ghost" slot="close">
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  isPending={pending === "delete"}
                  onPress={() => void act("delete", () => deleteRoutineAction(r.id), "Deleted.", "/routines")}
                >
                  Delete
                </Button>
              </AlertDialog.Footer>
            </AlertDialog.Dialog>
          </AlertDialog.Container>
        </AlertDialog.Backdrop>
      </AlertDialog>
    </>
  );
}

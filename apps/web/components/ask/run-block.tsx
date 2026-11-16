"use client";

import { Alert, Button, buttonVariants } from "@heroui/react";
import type { RunOutcome, RunView } from "@opendash/core";
import { Pair, PathLabel, StatusBadge } from "@opendash/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChartGantt, Copy, FileDown, Info, PanelRight, RotateCcw } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { DashboardPlanCard } from "@/components/dashboards/plan-card";
import { type DraftMade, DraftNote } from "@/components/knowledge/draft-note";
import { LearningCards } from "@/components/learning/learning-card";
import { RememberPopover } from "@/components/memory/remember-popover";
import { RememberedNote } from "@/components/memory/remembered-note";
import { usePanelIfAny } from "@/components/panel/panel-context";
import { apiQueries } from "@/lib/api";
import { composerBusy } from "@/lib/composer-busy";
import { pairStateOf } from "@/lib/pair-state";
import { chipText } from "@/lib/readings";
import { answerDraft, type RunStep, runSteps, runSummary } from "@/lib/run-steps";
import { AnswerBody } from "./answer-body";
import { AnswerDraft } from "./answer-draft";
import { AnswerFeedback } from "./answer-feedback";
import { RepeatAnswer, WatchAnswer } from "./answer-routines";
import type { TracedRef } from "./answer-text";
import { BuildCard } from "./build-card";
import { ClarifyCard } from "./clarify-card";
import { CorrectionNote } from "./correction-note";
import { McpCard } from "./mcp-card";
import { PausedCard } from "./paused-card";
import { RunStepsView } from "./run-steps-view";
import type { AnsweredWith } from "./sources-panel";
import { UndoChanges } from "./undo-changes";
import { useRunStream } from "./use-run-stream";

const ACTIVE = new Set(["queued", "running", "cancelling"]);
const POLL_MS = 500;

type Answer = Extract<RunOutcome, { kind: "answer" }>;

export interface InspectTarget {
  runId: string;
  answer: Answer | null;
  steps: RunStep[];
  trace: TracedRef | null;
  traceKey: string | null;
  /** What the run used: its model calls, tokens and cost, and how long it took. */
  usage: Record<string, number> & { seconds?: number };
  /** The model that answered, and what it ran on. */
  model: AnsweredWith;
  /** The question it answered (a verified query starts from it). */
  question: string;
}

/**
 * One turn's run: its steps while it works, then how it ended. Polls the run's events while it's
 * active; when it ends, the thread is read again for the outcome.
 */
export function RunBlock({
  run,
  source,
  question,
  threadId,
  latest,
  openSignal = 0,
  inspected,
  showing,
  onInspect,
  onRefresh,
  onAsk,
  onTrace,
}: {
  run: RunView;
  source: string;
  question: string;
  /** Its conversation (a memory saved from it links back). */
  threadId: string;
  latest: boolean;
  /** Bumped when the top bar's Sources button asks this run to open its sources. */
  openSignal?: number;
  /** The trace key shown in the Sources panel, when it's this run's. */
  inspected: string | null;
  onInspect: (target: InspectTarget) => void;
  /** Whether the Sources panel is showing this run: it's kept current as the run's steps and outcome change. */
  showing: boolean;
  onRefresh: (data: Pick<InspectTarget, "answer" | "steps" | "usage">) => void;
  /** Asks in this conversation (Retry, a clarifying answer). Absent when the reader can't add to it (shared). */
  onAsk?: (text: string) => void;
  /** Opens this run's trace. */
  onTrace?: (runId: string) => void;
}) {
  const queryClient = useQueryClient();
  const [now, setNow] = useState(() => Date.now());

  // Streamed while it's active (server-sent events); polled only when the stream isn't up.
  const streaming = useRef(false);
  const polled = useQuery({
    ...apiQueries.runs.events.queryOptions({ input: { runId: run.id, afterSeq: 0 } }),
    refetchInterval: (q) =>
      ACTIVE.has(q.state.data?.run.status ?? run.status) && !streaming.current ? POLL_MS : false,
  });
  const status = polled.data?.run.status ?? run.status;
  const active = ACTIVE.has(status);
  streaming.current = useRunStream(run.id, active && polled.data !== undefined);
  const outcome = (polled.data?.run.outcome ?? run.outcome) as RunOutcome | null;
  // The stream says "succeeded" a moment before the outcome lands: until it does, the run is finishing, not one that
  // ended without an answer.
  const finishing = status === "succeeded" && !outcome;
  const error = polled.data?.run.error ?? run.error;

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  // When the run ends, the thread (turns, the list's status) is read again.
  useEffect(() => {
    if (!active && run.status !== status) {
      void queryClient.invalidateQueries({ queryKey: apiQueries.threads.key() });
    }
  }, [active, run.status, status, queryClient]);

  const steps = useMemo(() => runSteps(polled.data?.events ?? [], { source }), [polled.data?.events, source]);
  // The answer as it streams: shown with every number a pill until the checked answer lands in its place.
  const draft = useMemo(() => answerDraft(polled.data?.events ?? []), [polled.data?.events]);
  // A draft shown here: its checked answer lands where it was, without rising in again.
  const draftShown = useRef(false);
  if ((active || finishing) && draft) draftShown.current = true;
  // What the analyst remembered for the asker in this run, or let go on their word.
  const remembered = useMemo(
    () =>
      (polled.data?.events ?? []).flatMap((e) => {
        const d = e.data as {
          tool?: string;
          remembered?: boolean;
          forgotten?: boolean;
          memoryId?: string;
          fact?: string;
          replaced?: string[];
          why?: string;
        };
        return e.type === "tool_result" &&
          d.tool === "remember" &&
          (d.remembered || d.forgotten) &&
          d.memoryId &&
          d.fact
          ? [
              {
                id: d.memoryId,
                fact: d.fact,
                forgotten: Boolean(d.forgotten),
                replaced: d.replaced ?? [],
                correction: d.why === "correction",
              },
            ]
          : [];
      }),
    [polled.data?.events],
  );
  // Only a run seen working here says what it changed: an old conversation read again leaves pages be.
  const seenWorking = useRef(false);
  // A run that starts working while a dashboard's page is beside the panel: the page is read again, so a build or a
  // change of that dashboard shows its build bar from its first moment (the page knows if the run is its own).
  const refreshedOnStart = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, when the run is first seen working
  useEffect(() => {
    if (!active || refreshedOnStart.current) return;
    refreshedOnStart.current = true;
    if (/^\/dashboards\/[0-9a-f-]{36}$/.test(pathname)) router.refresh();
  }, [active]);
  if (active) seenWorking.current = true;
  // The metrics and datasets this run drafted a change to (definition_draft): the latest draft of each. As
  // one lands, its page, when it's the one shown, is read again, so its draft and changes appear while the run works.
  const drafts = useMemo(() => {
    const latest = new Map<string, DraftMade>();
    for (const e of polled.data?.events ?? []) {
      const d = e.data as { tool?: string; definitionId?: string; kind?: string; title?: string; version?: number };
      if (e.type === "tool_result" && d.tool === "definition_draft" && d.definitionId) {
        latest.set(d.definitionId, {
          id: d.definitionId,
          kind: d.kind === "dataset" ? "dataset" : "metric",
          title: d.title ?? "it",
          version: d.version ?? 1,
          checks: (e.data as { checks?: string }).checks ?? "untested",
        });
      }
    }
    return [...latest.values()];
  }, [polled.data?.events]);
  const router = useRouter();
  const panel = usePanelIfAny();
  /** When this block was first shown: a run asked before it is history here. */
  const mountedAt = useRef(Date.now());
  const pathname = usePathname();
  const draftKey = drafts.map((d) => `${d.id}:${d.version}`).join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when a draft lands
  useEffect(() => {
    if (seenWorking.current && drafts.some((d) => pathname.endsWith(`/${d.id}`))) router.refresh();
  }, [draftKey]);
  // The dashboards this run saved a draft of (dashboard_save), at their latest revision. Seen working here, each save
  // shows its draft: the dashboard's page, when it's the one beside the panel, switches to its draft (filters kept);
  // the first save in the run opens it beside the panel (not from the full Ask page, which the person is reading).
  const savedDashboards = useMemo(() => {
    const latest = new Map<string, string>();
    for (const e of polled.data?.events ?? []) {
      const d = e.data as { tool?: string; dashboardId?: string; revision?: string; failed?: boolean };
      if (e.type !== "tool_result" || !d.dashboardId || d.failed) continue;
      // Made at Build it (nothing saved yet: its page draws the plan), then each page or whole save that lands.
      if (d.tool === "dashboard_start") latest.set(d.dashboardId, latest.get(d.dashboardId) ?? "start");
      else if ((d.tool === "dashboard_save" || d.tool === "dashboard_page") && d.revision) {
        latest.set(d.dashboardId, d.revision);
      }
    }
    return latest;
  }, [polled.data?.events]);
  const savedKey = [...savedDashboards].map(([id, rev]) => `${id}:${rev}`).join(",");
  // The dashboards this run changed that it didn't make: what "Undo these changes" puts back.
  const changedDashboards = useMemo(() => {
    const made = new Set<string>();
    for (const e of polled.data?.events ?? []) {
      const d = e.data as { tool?: string; dashboardId?: string };
      if (e.type === "tool_result" && d.tool === "dashboard_start" && d.dashboardId) made.add(d.dashboardId);
    }
    return [...savedDashboards].filter(([id, rev]) => rev !== "start" && !made.has(id)).map(([id]) => id);
  }, [polled.data?.events, savedDashboards]);
  // A dashboard this run began working on (opened, planned or saved): when it's the page beside the panel, the page is
  // read again once, so its build bar shows from the run's first call on it (a change asked from another conversation
  // too, where the dashboard's own conversation isn't the run's).
  const touched = useMemo(() => {
    const ids = new Set<string>();
    for (const e of polled.data?.events ?? []) {
      const d = e.data as { input?: { dashboard_id?: unknown } };
      if (e.type === "tool_started" && typeof d.input?.dashboard_id === "string") ids.add(d.input.dashboard_id);
    }
    return ids;
  }, [polled.data?.events]);
  const touchedHere = [...touched].find((id) => pathname === `/dashboards/${id}`) ?? null;
  const refreshedFor = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once a dashboard, when the run first works on it
  useEffect(() => {
    if (!touchedHere || !active || !seenWorking.current || refreshedFor.current === touchedHere) return;
    refreshedFor.current = touchedHere;
    router.refresh();
  }, [touchedHere, active]);
  const opened = useRef(false);
  // The saves already there when this run's events first load are history (a conversation opened again, a cached
  // view): only a save that lands after that moves the page.
  const loadedSaves = useRef<string | null>(null);
  const eventsLoaded = polled.data !== undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when a save lands
  useEffect(() => {
    if (!eventsLoaded) return;
    if (loadedSaves.current === null) {
      loadedSaves.current = savedKey;
      return;
    }
    if (savedKey === loadedSaves.current || !seenWorking.current || !savedDashboards.size) return;
    loadedSaves.current = savedKey;
    void queryClient.invalidateQueries({ queryKey: apiQueries.dashboards.key() });
    const [id] = [...savedDashboards.keys()].slice(-1);
    const here = [...savedDashboards.keys()].find((d) => pathname === `/dashboards/${d}`);
    const drafted = (d: string | undefined) => d !== undefined && savedDashboards.get(d) !== "start";
    if (here) {
      // The first save shown here counts as opened: a later one never pulls the person back from where they went.
      opened.current = true;
      const params = new URLSearchParams(window.location.search);
      if (params.get("draft") === "1" || !drafted(here)) router.refresh();
      else {
        params.set("draft", "1");
        router.replace(`${pathname}?${params.toString()}`);
      }
    } else if (id && !opened.current) {
      // Made (or first saved) here: it opens with this conversation beside it, its plan's pages as outlines until each
      // lands. From the full Ask page too: the conversation moves to the side and the dashboard takes the page, so the
      // person watches it build.
      if (pathname.startsWith("/ask")) {
        // From the full Ask page only for a run asked while it was open (never a conversation opened again, whose
        // saves are history), and never while something unsent is in its composer: the Built here link stays.
        const asked = Date.parse(run.queuedAt ?? "");
        if (!(asked >= mountedAt.current - 30_000) || composerBusy()) return;
        panel?.show({ threadId });
      }
      opened.current = true;
      router.push(`/dashboards/${id}${drafted(id) ? "?draft=1" : ""}`);
    }
  }, [savedKey, eventsLoaded]);
  const timing = { status, queuedAt: run.queuedAt, startedAt: run.startedAt, finishedAt: run.finishedAt };
  const answer = outcome?.kind === "answer" ? outcome : null;
  const summary = runSummary(steps, timing, now, answer);
  // A correction the viewer gave on this answer: what it was kept as, shown under its actions. The same query
  // as its thumbs, so one request.
  const mine = useQuery({
    ...apiQueries.feedback.mine.queryOptions({ input: { runId: run.id } }),
    enabled: answer !== null && status === "succeeded",
  });
  const kept = mine.data?.answer?.correction ?? null;
  const usage = useMemo(
    () => ({
      ...run.usage,
      ...(run.startedAt && run.finishedAt
        ? { seconds: (Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000 }
        : {}),
    }),
    [run.usage, run.startedAt, run.finishedAt],
  );
  const inspect = (trace: TracedRef | null, key: string | null) =>
    onInspect({ runId: run.id, answer, steps, trace, traceKey: key, usage, model: run.model, question });
  // The panel shows what this run did so far, opened mid-run or before its events had loaded.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshes when what it shows changes
  useEffect(() => {
    if (showing) onRefresh({ answer, steps, usage });
  }, [showing, steps, outcome, usage]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: opens only when the signal changes
  useEffect(() => {
    if (openSignal) inspect(null, null);
  }, [openSignal]);

  // Pair: moving while the run works; a run seen working here makes one small gesture as it ends, then holds
  // still, and one read again later holds still from its first frame.
  const pair = pairStateOf({ status, finishing, outcome, error, steps, waiting: latest && Boolean(onAsk) });
  const [gesture, setGesture] = useState(false);
  const wasMoving = useRef(pair.moving);
  useEffect(() => {
    const ended = wasMoving.current && !pair.moving;
    wasMoving.current = pair.moving;
    if (!ended) return;
    setGesture(true);
    const timer = setTimeout(() => setGesture(false), 2600);
    return () => clearTimeout(timer);
  }, [pair.moving]);

  // Its path is labelled when it has numbers or charts to label.
  const labelled = answer !== null && !(answer.checked?.numbers === 0 && !answer.charts?.length);
  const viewStatus = active ? "active" : status === "cancelled" ? "stopped" : status === "failed" ? "failed" : "done";
  // A build: one card at the top, its pages ticked as they land, above the steps. Only a run that builds (it
  // started the dashboard, or writes it a page at a time): a small change has no card.
  const building = useMemo(() => {
    const ids = new Set<string>();
    for (const e of polled.data?.events ?? []) {
      const d = e.data as { tool?: string; dashboardId?: string };
      if (e.type === "tool_result" && d.dashboardId && (d.tool === "dashboard_start" || d.tool === "dashboard_page"))
        ids.add(d.dashboardId);
    }
    return [...ids].at(-1) ?? null;
  }, [polled.data?.events]);
  const steps_ = (
    <RunStepsView
      summary={summary}
      steps={steps}
      status={viewStatus}
      answering={draft !== null}
      landing={seenWorking.current}
      runId={run.id}
      pair={<Pair state={pair.state} still={!pair.moving && !gesture} />}
      {...(onTrace ? { onTrace: () => onTrace(run.id) } : {})}
      aside={
        // An answer with no numbers ("Got it") has no path to label; one not answered from the data says so,
        // quietly, rather than as a failure.
        answer?.status === "cannot_answer" ? (
          <span className="inline-flex items-center gap-1.5 rounded-md bg-default px-2 py-0.5 text-small text-muted">
            <Info className="size-3.5 text-muted-tertiary" aria-hidden />
            Not answered from your data
          </span>
        ) : answer && (labelled || !answer.verified) ? (
          <>
            {labelled ? <PathLabel path={answer.path === "metric" ? "metric" : "unmodelled"} /> : null}
            {!answer.verified ? <StatusBadge status="unverified" /> : null}
          </>
        ) : null
      }
    />
  );
  const header = building ? (
    <div className="flex flex-col gap-3">
      <BuildCard
        dashboardId={building}
        runId={run.id}
        events={polled.data?.events ?? []}
        active={active}
        status={status}
        startedAt={run.startedAt ?? run.queuedAt ?? null}
        now={now}
        paused={
          outcome?.kind === "paused" ? { spentUsd: outcome.spentUsd, ceilingUsd: outcome.ceilingUsd ?? null } : null
        }
      />
      {steps_}
    </div>
  ) : (
    steps_
  );

  // Ended without an answer: stopped, interrupted, or an analyst that couldn't stand behind one.
  if (!active && !finishing && (!outcome || outcome.kind === "no_answer")) {
    const stopped = status === "cancelled";
    return (
      <div className="flex flex-col gap-3">
        {header}
        {stopped ? (
          <div className="flex flex-col gap-2">
            <p className="text-body text-muted">Stopped before an answer was checked, so no numbers are shown.</p>
            {onAsk ? (
              <Button size="sm" variant="outline" className="w-fit" onPress={() => onAsk(question)}>
                <RotateCcw className="size-3.5" aria-hidden />
                Retry
              </Button>
            ) : null}
          </div>
        ) : (
          <Alert status="danger">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>
                {error
                  ? "Something went wrong on our side. Nothing was lost."
                  : "The analyst couldn't finish an answer."}
              </Alert.Title>
              <Alert.Description>
                {error
                  ? "Your question and the queries that finished are saved. Try again and OpenDash continues from there."
                  : outcome?.kind === "no_answer"
                    ? outcome.reason
                    : "Try asking again, perhaps more specifically."}
              </Alert.Description>
            </Alert.Content>
            {onAsk ? (
              <Button size="sm" variant="secondary" onPress={() => onAsk(question)}>
                <RotateCcw className="size-3.5" aria-hidden />
                Try again
              </Button>
            ) : null}
          </Alert>
        )}
      </div>
    );
  }

  if (outcome?.kind === "paused") {
    return (
      <div className="flex flex-col gap-3">
        {header}
        <div className={seenWorking.current ? "enter-rise" : undefined}>
          <PausedCard
            outcome={outcome}
            question={question}
            can={latest && Boolean(onAsk)}
            {...(onAsk ? { onAsk } : {})}
          />
        </div>
      </div>
    );
  }

  if (outcome?.kind === "mcp_connect" || outcome?.kind === "mcp_consent") {
    return (
      <div className="flex flex-col gap-3">
        {header}
        <div className={seenWorking.current ? "enter-rise" : undefined}>
          <McpCard outcome={outcome} can={latest && Boolean(onAsk)} {...(onAsk ? { onAsk } : {})} />
        </div>
      </div>
    );
  }

  if (outcome?.kind === "dashboard_plan") {
    return (
      <div className="flex flex-col gap-3">
        {header}
        <div className={seenWorking.current ? "enter-rise" : undefined}>
          <DashboardPlanCard plan={outcome} can={latest && Boolean(onAsk)} {...(onAsk ? { onAsk } : {})} />
        </div>
      </div>
    );
  }

  if (outcome?.kind === "clarify") {
    return (
      <div className="flex flex-col gap-3">
        {header}
        <div className={seenWorking.current ? "enter-rise" : undefined}>
          <ClarifyCard outcome={outcome} can={latest && Boolean(onAsk)} {...(onAsk ? { onAsk } : {})} />
        </div>
      </div>
    );
  }

  if (!answer) {
    // Still working: the steps say what's happening; numbers only ever appear once checked.
    return (
      <div className="flex flex-col gap-3">
        {header}
        {status === "queued" ? (
          <p className="text-small text-muted-tertiary">Waiting for the analyst to start…</p>
        ) : null}
        {(active || finishing) && draft ? (
          <div className="enter-fade">
            <AnswerDraft draft={draft.text} held={draft.held} />
          </div>
        ) : null}
      </div>
    );
  }

  const segments = answer.segments;
  const couldNot = answer.status === "cannot_answer";
  return (
    <div className="flex flex-col gap-3">
      {header}
      {/* Seen being written, the checked answer lands where its draft was: its text stays put and its numbers fade in
          where the pills were, while what the draft didn't have grows or rises in around it. Seen working without a
          draft, it rises in (motion). */}
      <div
        className={`flex flex-col gap-3 ${draftShown.current ? "answer-landing" : seenWorking.current ? "enter-rise" : ""}`}
      >
        <AnswerBody
          answer={answer}
          question={question}
          inspected={inspected}
          onTrace={(ref, key) => inspect(ref, key)}
          {...(onAsk ? { onAsk } : {})}
        >
          {drafts.map((d) => (
            <DraftNote key={d.id} draft={d} />
          ))}
          {remembered.map((m) => (
            <RememberedNote
              key={`${m.forgotten ? "f" : "r"}-${m.id}`}
              id={m.id}
              fact={m.fact}
              canUndo={Boolean(onAsk)}
              forgotten={m.forgotten}
              replaced={m.replaced}
              canShare={m.correction}
            />
          ))}
          <LearningCards runId={run.id} corrected={remembered.some((m) => m.correction && !m.forgotten)} />
        </AnswerBody>
        {/* Wraps in the narrow analyst panel rather than running off its edge. */}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onPress={() => void navigator.clipboard?.writeText(answer.rendered).catch(() => {})}
          >
            <Copy className="size-3.5" aria-hidden />
            Copy
          </Button>
          <Button size="sm" variant="ghost" onPress={() => inspect(null, null)}>
            <PanelRight className="size-3.5" aria-hidden />
            Sources
          </Button>
          {onTrace ? (
            <Button size="sm" variant="ghost" onPress={() => onTrace(run.id)}>
              <ChartGantt className="size-3.5" aria-hidden />
              Trace
            </Button>
          ) : null}
          {onAsk ? (
            <RememberPopover threadId={threadId} readings={(segments?.interpretation ?? []).map(chipText)} />
          ) : null}
          {!couldNot && status === "succeeded" ? (
            <a
              href={`/runs/${run.id}/pdf`}
              download
              className={`${buttonVariants({ size: "sm", variant: "ghost" })} gap-1.5`}
            >
              <FileDown className="size-3.5" aria-hidden />
              PDF
            </a>
          ) : null}
          {/* A routine from it: asked again on a schedule, or its verified metrics watched. */}
          {onAsk && !couldNot && status === "succeeded" ? <RepeatAnswer runId={run.id} /> : null}
          {onAsk && !couldNot && status === "succeeded" && answer.path === "metric" ? (
            <WatchAnswer runId={run.id} />
          ) : null}
          {onAsk && status === "succeeded" && changedDashboards.length ? (
            <UndoChanges runId={run.id} dashboardIds={changedDashboards} />
          ) : null}
          <span className="flex-1" />
          <AnswerFeedback runId={run.id} />
          {couldNot && onAsk ? (
            <Button size="sm" variant="ghost" onPress={() => onAsk(question)}>
              <RotateCcw className="size-3.5" aria-hidden />
              Try again
            </Button>
          ) : null}
        </div>
        {kept ? (
          <CorrectionNote
            runId={run.id}
            kept={kept}
            {...(onAsk ? { onAsk } : {})}
            onUndone={() => void queryClient.invalidateQueries({ queryKey: apiQueries.feedback.key() })}
          />
        ) : null}
      </div>
    </div>
  );
}

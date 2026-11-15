"use client";

import { Button, Chip } from "@heroui/react";
import { useQueryClient } from "@tanstack/react-query";
import { FolderInput, FolderKanban, PanelRight, Users } from "lucide-react";
import { useState } from "react";
import { MoveToProject, type ProjectChoice } from "@/components/projects/move-to-project";
import { TraceAside } from "@/components/runs/run-trace";
import { TopBar } from "@/components/shell/top-bar";
import { apiQueries } from "@/lib/api";
import { Conversation, useThread } from "./conversation";
import type { InspectTarget } from "./run-block";
import { ShareThread } from "./share-thread";
import { SourcesPanel } from "./sources-panel";
import { ThreadsPane } from "./threads-pane";

/**
 * A conversation, as a page. The threads on the left, the conversation (its turns and composer, the same
 * one the panel beside a page draws), and the Sources panel opening on an answer or a traced number.
 */
export function ThreadView({
  threadId,
  org,
  canAsk,
  canVerify = false,
  projects = [],
}: {
  threadId: string;
  org: string;
  canAsk: boolean;
  /** Owners and admins may save an answer's metric query as verified. */
  canVerify?: boolean;
  /** The projects this person can see: its project's name, and where its author can move it. */
  projects?: ProjectChoice[];
}) {
  const queryClient = useQueryClient();
  const [now] = useState(() => Date.now());
  const [inspect, setInspectState] = useState<InspectTarget | null>(null);
  // A run's trace opens where the Sources panel does, one of them at a time.
  const [traceRun, setTraceRun] = useState<string | null>(null);
  const setInspect: typeof setInspectState = (next) => {
    // Opening Sources closes the trace; keeping Sources current (an update from its run) doesn't.
    if (next !== null && typeof next !== "function") setTraceRun(null);
    setInspectState(next);
  };
  // The top bar's Sources button asks the latest run to open its sources (it holds the steps).
  const [openSignal, setOpenSignal] = useState(0);
  const [moving, setMoving] = useState(false);
  const thread = useThread(threadId);
  const t = thread.data?.thread;
  const latestRun = thread.data?.turns.at(-1)?.run ?? null;
  const project = t?.projectId ? (projects.find((p) => p.id === t.projectId) ?? null) : null;

  return (
    <div className="flex h-full min-h-0">
      {/* With the Sources panel open, the threads step aside until the screen is wide enough for both. */}
      <div className={inspect || traceRun ? "hidden @7xl/page:flex" : "hidden @4xl/page:flex"}>
        <ThreadsPane activeId={threadId} now={now} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar
          crumbs={
            project
              ? [{ label: project.name, href: `/projects/${project.id}` }, { label: t?.title ?? "Conversation" }]
              : [{ label: "Ask", href: "/ask" }, { label: t?.title ?? "Conversation" }]
          }
          badge={
            t && (t.visibility !== "private" || !t.mine) ? (
              <Chip size="sm" variant="soft" color="accent">
                {t.visibility === "project" ? (
                  <FolderKanban className="size-3" aria-hidden />
                ) : (
                  <Users className="size-3" aria-hidden />
                )}
                {t.mine
                  ? t.visibility === "project"
                    ? `Shared with ${project?.name ?? "the project"}`
                    : "Shared"
                  : `Shared by ${t.author ?? "a teammate"}`}
              </Chip>
            ) : null
          }
          action={
            <span className="flex gap-1">
              {t?.mine ? (
                <ShareThread threadId={threadId} org={org} project={project?.name ?? null} visibility={t.visibility} />
              ) : null}
              {t?.mine ? (
                <Button size="sm" variant="ghost" onPress={() => setMoving(true)}>
                  <FolderInput className="size-3.5" aria-hidden />
                  {project ? "Move" : "Move to project"}
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="ghost"
                isDisabled={!latestRun}
                onPress={() => (inspect ? setInspect(null) : setOpenSignal((n) => n + 1))}
              >
                <PanelRight className="size-3.5" aria-hidden />
                Sources
              </Button>
            </span>
          }
        />
        <Conversation
          threadId={threadId}
          org={org}
          canAsk={canAsk}
          variant="page"
          inspect={inspect}
          setInspect={setInspect}
          openSignal={openSignal}
          onTrace={(runId) => {
            setInspectState(null);
            setTraceRun(runId);
          }}
        />
      </div>
      {traceRun ? (
        <div className="enter-slide absolute inset-0 z-40 flex bg-surface @5xl/page:static @5xl/page:z-auto">
          <TraceAside key={traceRun} runId={traceRun} onClose={() => setTraceRun(null)} />
        </div>
      ) : null}
      {inspect ? (
        <div className="enter-slide absolute inset-0 z-40 flex bg-surface @5xl/page:static @5xl/page:z-auto">
          <SourcesPanel
            runId={inspect.runId}
            answer={inspect.answer}
            steps={inspect.steps}
            source={t?.sourceName ?? "the source"}
            trace={inspect.trace}
            usage={inspect.usage}
            model={inspect.model}
            verifyQuestion={canVerify ? inspect.question : null}
            canDraft={canAsk}
            onBack={() => setInspect({ ...inspect, trace: null, traceKey: null })}
            onClose={() => setInspect(null)}
          />
        </div>
      ) : null}
      {t?.mine ? (
        <MoveToProject
          item={{ kind: "thread", id: threadId }}
          title={t.title}
          current={t.projectId}
          projects={projects}
          isOpen={moving}
          onOpenChange={setMoving}
          onMoved={() => void queryClient.invalidateQueries({ queryKey: apiQueries.threads.key() })}
        />
      ) : null}
    </div>
  );
}

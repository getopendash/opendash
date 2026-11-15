"use client";

import { buttonVariants, Skeleton } from "@heroui/react";
import { isDefinedError } from "@opendash/api/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, SquarePen } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { type Dispatch, type SetStateAction, useEffect, useRef, useState } from "react";
import { BuiltHere } from "@/components/dashboards/built-here";
import { apiQueries } from "@/lib/api";
import { AskComposer } from "./ask-composer";
import { type AttachedItem, AttachmentChips, sentAttachment } from "./attach-picker";
import { FollowUpBubble } from "./follow-up";
import { useChosenModel } from "./model-picker";
import { type InspectTarget, RunBlock } from "./run-block";

const ACTIVE = new Set(["queued", "running", "cancelling"]);

/** The conversation's thread, read once by whoever draws it (the page's top bar, the turns, the panel's header). */
export function useThread(threadId: string) {
  return useQuery({
    ...apiQueries.threads.get.queryOptions({ input: { threadId } }),
    // While the latest run works, its own polling drives the steps; the thread is read again when it ends, and while a
    // follow-up waits to be read (it moves up once read).
    refetchInterval: (q) => {
      const last = q.state.data?.turns.at(-1);
      return last?.run?.status === "queued" || last?.followUps.some((f) => f.state !== "read") ? 1_000 : false;
    },
  });
}

/**
 * A conversation's turns and its composer: the same on the Ask page and in the panel beside a
 * page. Questions on the right, each answered by its run; the composer asks a follow-up, or, while an answer is worked
 * on, adds to it, with Stop beside it. In the panel, the page's chip goes with the next question.
 */
export function Conversation({
  threadId,
  org,
  canAsk,
  variant,
  inspect,
  setInspect,
  openSignal = 0,
  focus = null,
  draft = null,
  onDraftTaken,
  incoming,
  onIncomingTaken,
  onTrace,
}: {
  threadId: string;
  org: string;
  canAsk: boolean;
  variant: "page" | "panel";
  /** What the Sources view shows, and its setter: the page draws it beside, the panel stacks it. */
  inspect: InspectTarget | null;
  setInspect: Dispatch<SetStateAction<InspectTarget | null>>;
  /** Bumped when the page's Sources button asks the latest run to open its sources. */
  openSignal?: number;
  /** What the page beside the panel shows: offered as a chip with the next question. */
  focus?: AttachedItem | null;
  /** A question to start from, put in the composer once. */
  draft?: { text: string; nonce: number } | null;
  onDraftTaken?: (nonce: number) => void;
  /** Chips added from the page beside the panel (a piece of an App selected there), each once. */
  incoming?: { item: AttachedItem; nonce: number }[];
  onIncomingTaken?: (nonces: number[]) => void;
  /** Opens a run's trace: beside the page on Ask, in the panel there. */
  onTrace?: (runId: string) => void;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  // Where the next question starts, when the asker switched it; the conversation's own otherwise. Sample
  // data and the organization's own stay apart, so a follow-up offers the sources on its side only.
  const end = useRef<HTMLDivElement>(null);

  const thread = useThread(threadId);
  const sources = useQuery(apiQueries.sources.askable.queryOptions());
  const current = (sources.data ?? []).find((x) => x.id === thread.data?.thread.connectionId);
  const followUpSources = (sources.data ?? []).filter((x) => !current || x.sample === current.sample);
  const ask = useMutation(apiQueries.ask.submit.mutationOptions());
  const stop = useMutation(apiQueries.runs.stop.mutationOptions());
  const takeBack = useMutation(
    apiQueries.ask.takeBack.mutationOptions({
      onSettled: () => void queryClient.invalidateQueries({ queryKey: apiQueries.threads.key() }),
    }),
  );

  const turns = thread.data?.turns ?? [];
  const latestRun = turns.at(-1)?.run ?? null;
  const running = latestRun !== null && ACTIVE.has(latestRun.status);
  const count = turns.length;

  // The model for the next question, shared by the composer and the answer's suggested follow-ups.
  const chosen = useChosenModel();

  // A new turn scrolls into view, smoothly unless someone asked for less motion.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the number of turns changes
  useEffect(() => {
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    end.current?.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "end" });
  }, [count]);
  // The turns there when the conversation loaded fade in from its placeholder; a turn asked after that rises in.
  const loaded = useRef<Set<string> | null>(null);
  if (loaded.current === null && thread.data) loaded.current = new Set(turns.map((turn) => turn.message.id));

  if (thread.error && isDefinedError(thread.error) && thread.error.code === "NOT_FOUND") {
    if (variant === "page") notFound();
    return <p className="p-4 text-body text-muted">This conversation was deleted, or isn't shared with you.</p>;
  }

  const t = thread.data?.thread;
  // A shared conversation is read by others; only its author adds to it (and a viewer asks nothing).
  const author = t?.mine ?? true;
  const writable = author && canAsk;
  // A suggested follow-up (an answer's chips) asks with what the composer shows.
  const followUp = (text: string, choice = chosen.value, attachments: AttachedItem[] = []) => {
    setError(null);
    ask.mutate(
      {
        text,
        threadId,
        ...(choice ?? {}),
        ...(attachments.length ? { attachments: attachments.map(sentAttachment) } : {}),
      },
      {
        onSuccess: () => {
          void queryClient.invalidateQueries({ queryKey: apiQueries.threads.key() });
        },
        onError: (e) => setError(isDefinedError(e) ? e.message : "Couldn't send that. Try again."),
      },
    );
  };
  const panel = variant === "panel";

  return (
    <>
      <div className={`flex-1 overflow-y-auto ${panel ? "px-4 pt-4 pb-6" : "px-6 pt-6 pb-8"}`}>
        <div className={`flex flex-col ${panel ? "gap-6" : "mx-auto max-w-reading gap-8"}`}>
          {thread.isPending ? <Skeleton className="h-40 rounded-2xl" /> : null}
          {turns.map((turn, i) => (
            <section
              key={turn.message.id}
              className={`flex flex-col gap-4 ${loaded.current?.has(turn.message.id) ? "enter-fade" : "enter-rise"}`}
            >
              <div className="flex max-w-xl flex-col items-end gap-1.5 self-end">
                <AttachmentChips items={turn.message.attachments} align="end" />
                <p className="whitespace-pre-line rounded-2xl bg-default px-3.5 py-2 text-lead">{turn.message.text}</p>
              </div>
              {turn.followUps
                .filter((f) => f.state === "read")
                .map((f) => (
                  <FollowUpBubble key={f.id} followUp={f} />
                ))}
              {turn.run ? (
                <RunBlock
                  run={turn.run}
                  source={t?.sourceName ?? "the source"}
                  question={turn.message.text}
                  threadId={threadId}
                  latest={i === turns.length - 1}
                  openSignal={i === turns.length - 1 ? openSignal : 0}
                  inspected={inspect?.runId === turn.run.id ? inspect.traceKey : null}
                  showing={inspect?.runId === turn.run.id}
                  onInspect={setInspect}
                  onRefresh={(d) => {
                    const id = turn.run?.id;
                    setInspect((prev) => (prev && prev.runId === id ? { ...prev, ...d } : prev));
                  }}
                  {...(writable ? { onAsk: followUp } : {})}
                  {...(onTrace ? { onTrace } : {})}
                />
              ) : null}
              {turn.followUps
                .filter((f) => f.state !== "read")
                .map((f) => (
                  <FollowUpBubble
                    key={f.id}
                    followUp={f}
                    {...(writable ? { onTakeBack: () => takeBack.mutate({ messageId: f.id }) } : {})}
                  />
                ))}
            </section>
          ))}
          <BuiltHere threadId={threadId} />
          <div ref={end} />
        </div>
      </div>
      <div className={panel ? "px-3 pb-3" : "px-6 pb-5"}>
        <div className={panel ? "" : "mx-auto max-w-reading"}>
          {t && !writable ? (
            <div className="flex items-center gap-3 rounded-2xl border border-border bg-surface-secondary px-4 py-3">
              <Eye className="size-4 shrink-0 text-muted" aria-hidden />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <p className="text-body font-medium">
                  {author
                    ? `You're a viewer in ${org}`
                    : `${t.author ?? "A teammate"} shared this conversation with ${org}`}
                </p>
                <p className="text-small text-muted">
                  {author
                    ? "Viewers read the conversations shared with them. Ask an admin for the Member role to ask questions."
                    : `You can read it, open the query behind each number and give feedback. Only ${t.author ?? "the person who started it"} can add to it.`}
                </p>
              </div>
              {canAsk ? (
                <Link
                  href="/ask/new"
                  className={`${buttonVariants({ size: "sm", variant: "outline" })} shrink-0 gap-1`}
                >
                  <SquarePen className="size-3.5" aria-hidden />
                  Ask your own question
                </Link>
              ) : null}
            </div>
          ) : null}
          {t && writable && !t.sourceUsable ? (
            <p className="pb-2 text-small text-muted">
              {t.sourceName} was removed or disabled: pick another source below to go on.
            </p>
          ) : null}
          {writable ? (
            <AskComposer
              sources={followUpSources}
              sourceId={t?.connectionId ?? null}
              placeholder={focus && panel ? `Ask about ${focus.title}…` : "Ask a follow-up…"}
              running={running}
              pending={ask.isPending}
              error={error}
              onSubmit={followUp}
              chosen={chosen}
              focus={focus}
              draft={draft}
              {...(onDraftTaken ? { onDraftTaken } : {})}
              {...(incoming ? { incoming } : {})}
              {...(onIncomingTaken ? { onIncomingTaken } : {})}
              compact={panel}
              onStop={() => latestRun && stop.mutate({ runId: latestRun.id })}
            />
          ) : null}
        </div>
      </div>
    </>
  );
}

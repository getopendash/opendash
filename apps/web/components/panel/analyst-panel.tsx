"use client";

import { Button, Dropdown, Label } from "@heroui/react";
import { isDefinedError } from "@opendash/api/client";
import type { ModelChoice } from "@opendash/core";
import { SidePanel } from "@opendash/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Maximize2, MessagesSquare, SquarePen } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { AskComposer } from "@/components/ask/ask-composer";
import { type AttachedItem, sentAttachment } from "@/components/ask/attach-picker";
import { Conversation } from "@/components/ask/conversation";
import { useChosenModel } from "@/components/ask/model-picker";
import type { InspectTarget } from "@/components/ask/run-block";
import { SourcesPanel } from "@/components/ask/sources-panel";
import { RunTrace } from "@/components/runs/run-trace";
import { apiQueries } from "@/lib/api";
import { ago } from "@/lib/format";
import { startingSource } from "@/lib/starting-source";
import { usePanel } from "./panel-context";

/**
 * The analyst beside every page: one conversation, docked as a second sheet beside whatever the
 * page shows, kept while its person moves around. The page's chip goes with the next question; what opens from the
 * conversation (Sources, a trace) stacks one level. On Ask itself the page is the conversation, so it
 * steps aside there.
 */
export function AnalystPanel({ org, canAsk, canVerify }: { org: string; canAsk: boolean; canVerify: boolean }) {
  const panel = usePanel();
  const router = useRouter();
  const pathname = usePathname();
  const [inspect, setInspect] = useState<InspectTarget | null>(null);
  const { threadId, focus } = panel;
  // A new conversation (or another one) starts without the last one's Sources open.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the conversation changes
  useEffect(() => setInspect(null), [threadId]);
  // A trace opened from elsewhere (Activity, a drafting card) is shown, not the Sources left open under it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when a trace is asked for
  useEffect(() => {
    if (panel.view === "trace") setInspect(null);
  }, [panel.view, panel.traceRunId]);
  const thread = useQuery({
    ...apiQueries.threads.get.queryOptions({ input: { threadId: threadId ?? "" } }),
    enabled: threadId !== null,
  });
  const earlier = useQuery({
    ...apiQueries.threads.list.queryOptions({
      input: {
        scope: "mine",
        attached: {
          // A page's focus is never a file, an image or a selected piece (those are attached, not on screen).
          kind:
            focus && focus.item.kind !== "file" && focus.item.kind !== "image" && focus.item.kind !== "app_element"
              ? focus.item.kind
              : "metric",
          id: focus?.item.id ?? "00000000-0000-0000-0000-000000000000",
        },
        limit: 8,
      },
    }),
    enabled: panel.open && focus !== null,
  });
  const [now] = useState(() => Date.now());
  // Closed, nothing in it keeps the keyboard: a box still focused under a hidden sheet would send on Enter.
  const sheet = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const active = document.activeElement;
    if (!panel.open && active instanceof HTMLElement && sheet.current?.contains(active)) active.blur();
  }, [panel.open]);

  // On Ask the page is the conversation.
  if (pathname === "/ask" || pathname.startsWith("/ask/")) return null;
  const t = thread.data?.thread;
  const view = inspect ? "sources" : panel.view === "trace" && panel.traceRunId ? "trace" : "conversation";
  const others = (earlier.data ?? []).filter((x) => x.id !== threadId);
  const back = { crumb: "Ask", onPress: () => (inspect ? setInspect(null) : panel.setView("conversation")) };

  // One sheet, whatever it shows: the conversation stays mounted under Sources and a trace, and while the panel is
  // closed, so a run it's following goes on being followed (the page's bar, its refresh) and nothing typed is lost.
  return (
    <div ref={sheet} className="contents">
      <SidePanel
        hidden={!panel.open}
        animate={panel.animate}
        title={view === "sources" ? "Sources" : view === "trace" ? "Trace" : "Ask"}
        subtitle={view === "trace" ? null : threadId ? (t?.title ?? null) : focus ? `About ${focus.item.title}` : null}
        back={view === "conversation" ? null : back}
        onClose={panel.close}
        closeLabel="Close the analyst (⌘J)"
        wide={view !== "conversation"}
        resizeKey="od-analyst-panel-width"
        actions={
          view === "conversation" ? (
            <>
              {focus && others.length ? (
                <Dropdown>
                  <Button isIconOnly size="sm" variant="ghost" aria-label={`Earlier about ${focus.item.title}`}>
                    <MessagesSquare className="size-4 text-muted" aria-hidden />
                  </Button>
                  <Dropdown.Popover placement="bottom end" className="min-w-72 max-w-80">
                    <Dropdown.Menu aria-label="Earlier conversations" onAction={(key) => panel.setThread(String(key))}>
                      {others.map((x) => (
                        <Dropdown.Item key={x.id} id={x.id} textValue={x.title}>
                          <span className="flex min-w-0 flex-col">
                            <Label className="truncate">{x.title}</Label>
                            <span className="text-small text-muted-tertiary">
                              {ago(x.lastMessageAt ?? x.createdAt, now)}
                            </span>
                          </span>
                        </Dropdown.Item>
                      ))}
                    </Dropdown.Menu>
                  </Dropdown.Popover>
                </Dropdown>
              ) : null}
              {threadId ? (
                <>
                  <Button
                    isIconOnly
                    size="sm"
                    variant="ghost"
                    aria-label="New conversation"
                    onPress={() => panel.setThread(null)}
                  >
                    <SquarePen className="size-4 text-muted" aria-hidden />
                  </Button>
                  <Button
                    isIconOnly
                    size="sm"
                    variant="ghost"
                    aria-label="Open as a page"
                    onPress={() => {
                      panel.close();
                      router.push(`/ask/${threadId}`);
                    }}
                  >
                    <Maximize2 className="size-4 text-muted" aria-hidden />
                  </Button>
                </>
              ) : null}
            </>
          ) : null
        }
      >
        {/* What opens from the conversation (Sources, a trace) slides in over it (motion). */}
        {view === "sources" && inspect ? (
          <div className="enter-slide flex min-h-0 flex-1 flex-col">
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
              embedded
            />
          </div>
        ) : null}
        {view === "trace" && panel.traceRunId ? (
          <div className="enter-slide flex min-h-0 flex-1 flex-col">
            <RunTrace key={panel.traceRunId} runId={panel.traceRunId} live={panel.open} />
          </div>
        ) : null}
        <div hidden={view !== "conversation"} className="flex min-h-0 flex-1 flex-col">
          {threadId ? (
            <Conversation
              key={threadId}
              threadId={threadId}
              org={org}
              canAsk={canAsk}
              variant="panel"
              inspect={inspect}
              setInspect={setInspect}
              focus={focus?.item ?? null}
              draft={panel.draft}
              onDraftTaken={panel.takeDraft}
              incoming={panel.incoming}
              onIncomingTaken={panel.takeIncoming}
              onTrace={(runId) => panel.show({ view: "trace", runId })}
            />
          ) : (
            <PanelStart
              canAsk={canAsk}
              open={panel.open && view === "conversation"}
              focus={focus?.item ?? null}
              connectionId={focus?.connectionId ?? panel.startSource}
              others={others
                .slice(0, 5)
                .map((x) => ({ id: x.id, title: x.title, when: ago(x.lastMessageAt ?? x.createdAt, now) }))}
            />
          )}
        </div>
      </SidePanel>
    </div>
  );
}

/**
 * A new conversation in the panel: about what the page shows when it shows something (its chip in the composer), the
 * conversations earlier about it, and the composer. Asking opens the conversation here, not on Ask.
 */
function PanelStart({
  canAsk,
  open,
  focus,
  connectionId,
  others,
}: {
  canAsk: boolean;
  /** Shown: the composer takes the focus then (it stays mounted while the panel is closed). */
  open: boolean;
  focus: AttachedItem | null;
  connectionId: string | null;
  others: { id: string; title: string; when: string }[];
}) {
  const panel = usePanel();
  const queryClient = useQueryClient();
  const sources = useQuery(apiQueries.sources.askable.queryOptions());
  const list = sources.data ?? [];
  const sourceId = startingSource(list, connectionId);
  const chosen = useChosenModel();
  const [error, setError] = useState<string | null>(null);
  const ask = useMutation(apiQueries.ask.submit.mutationOptions());
  const submit = (text: string, choice: ModelChoice | null, attachments: AttachedItem[]) => {
    if (!sourceId) return;
    setError(null);
    ask.mutate(
      {
        text,
        connectionId: sourceId,
        // The client id makes a double submit (a retried request) land on the same conversation.
        clientMsgId: crypto.randomUUID(),
        ...(choice ?? {}),
        ...(attachments.length ? { attachments: attachments.map(sentAttachment) } : {}),
      },
      {
        onSuccess: ({ threadId }) => {
          panel.setThread(threadId);
          // Ask's list (and this page's "Earlier about this") has it now.
          void queryClient.invalidateQueries({ queryKey: apiQueries.threads.key() });
        },
        onError: (e) => setError(isDefinedError(e) ? e.message : "Couldn't send that. Try again."),
      },
    );
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 pt-5 pb-4">
        <div className="flex flex-col gap-1">
          {/* Opened from New dashboard or a starter: what happens next, in a line. */}
          {!focus && panel.intent === "dashboard" ? (
            <>
              <p className="text-lead font-medium">New dashboard</p>
              <p className="text-body text-muted">
                Say who it's for and what they decide with it. You'll see a plan first; then it builds on its page while
                you watch.
              </p>
            </>
          ) : (
            <>
              <p className="text-lead font-medium">{focus ? `Ask about ${focus.title}` : "Ask the analyst"}</p>
              <p className="text-body text-muted">
                It reads your sources, checks every number and shows the query behind it. This conversation stays here
                as you move around.
              </p>
            </>
          )}
        </div>
        {others.length ? (
          <div className="flex flex-col gap-1">
            <p className="text-small text-muted-tertiary">Earlier about this</p>
            <ul className="flex flex-col">
              {others.map((x) => (
                <li key={x.id}>
                  <button
                    type="button"
                    onClick={() => panel.setThread(x.id)}
                    className="flex w-full items-baseline justify-between gap-3 rounded-lg px-2 py-1.5 text-start hover:bg-surface-secondary"
                  >
                    <span className="truncate text-body">{x.title}</span>
                    <span className="shrink-0 text-small text-muted-tertiary">{x.when}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
      <div className="px-3 pb-3">
        {canAsk ? (
          list.length ? (
            <AskComposer
              sources={list}
              sourceId={sourceId}
              placeholder={focus ? `Ask about ${focus.title}…` : "Ask a question…"}
              running={false}
              pending={ask.isPending || ask.isSuccess}
              error={error}
              onSubmit={submit}
              chosen={chosen}
              focus={focus}
              draft={panel.draft}
              onDraftTaken={panel.takeDraft}
              incoming={panel.incoming}
              onIncomingTaken={panel.takeIncoming}
              compact
              autoFocus={open}
            />
          ) : (
            <p className="text-body text-muted">Connect a database and let OpenDash learn it first.</p>
          )
        ) : (
          <p className="text-body text-muted">Viewers read the conversations shared with them.</p>
        )}
      </div>
    </div>
  );
}

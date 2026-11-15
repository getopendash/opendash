"use client";

import { Button, Dropdown, Label, toast } from "@heroui/react";
import type { AskableSource } from "@opendash/api/client";
import type { ModelChoice } from "@opendash/core";
import { ArrowUp, Check, ChevronDown, CircleAlert, Database, Square } from "lucide-react";
import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { appendAttached } from "@/lib/app-selection";
import { setComposerBusy } from "@/lib/composer-busy";
import {
  type AttachedItem,
  AttachmentChips,
  AttachPicker,
  FocusChip,
  MAX_ATTACHED,
  ReferencePicker,
} from "./attach-picker";
import { ChatModelPicker, type ChosenModel, useChosenModel } from "./model-picker";

const DIALECTS: Record<string, string> = { postgres: "PostgreSQL", clickhouse: "ClickHouse", mysql: "MySQL" };
const dialectName = (d: string) => DIALECTS[d] ?? d;

/**
 * The Ask composer: the question, the source it starts from (a chip; a follow-up can switch it,
 * and the analyst reads the organization's other sources when a question needs them), what's attached to it
 * (`@`), the model to ask with and how long it thinks (any question, a follow-up too), send on Enter, and
 * Stop while the analyst works (Esc).
 */
/**
 * The question box grows with its text, up to a few lines, however the text got there. Measured while hidden (a panel
 * still opening) it reads 0: then it keeps its own one line, never 0px, so it can always be typed in.
 */
function fitBox(box: HTMLTextAreaElement | null) {
  if (!box) return;
  box.style.height = "auto";
  const tall = box.scrollHeight;
  box.style.height = box.value && tall > 0 ? `${Math.min(tall, 160)}px` : "";
}

export function AskComposer({
  sources,
  sourceId,
  placeholder,
  running,
  pending,
  error,
  onSubmit,
  onStop,
  autoFocus,
  initialText = "",
  chosen: shared,
  initialAttachments = [],
  focus = null,
  draft = null,
  onDraftTaken,
  incoming: added = [],
  onIncomingTaken,
  compact = false,
  onWriting,
}: {
  sources: AskableSource[];
  sourceId: string | null;
  /** Switches where the question starts (a new conversation's, or a follow-up's); absent, the chip only shows it. */
  placeholder: string;
  running: boolean;
  pending: boolean;
  error?: string | null;
  /** The question, the model, provider and level chosen for it (null: nothing's on offer yet), what's attached. */
  onSubmit: (text: string, choice: ModelChoice | null, attachments: AttachedItem[]) => void;
  onStop?: () => void;
  autoFocus?: boolean;
  /** A question to start from (a suggestion opened from Home), ready to send or edit. */
  initialText?: string;
  /** The model choice, when the page shares it with other ways of asking (suggested questions and follow-ups). */
  chosen?: ChosenModel;
  /** Attached from the start ("Edit with the analyst" opens a question with its dashboard attached). */
  initialAttachments?: AttachedItem[];
  /**
   * What the page beside it shows: a chip that goes with the next question as an attachment, unless it's
   * taken off first. Already part of the conversation, it's shown and not sent again (a follow-up with something
   * attached would wait for the answer rather than join it).
   */
  focus?: AttachedItem | null;
  /** A question put in the box from elsewhere (a tile's "Make it rolling"), once per nonce, when the box is empty. */
  draft?: { text: string; nonce: number } | null;
  /** The draft is in the box: it isn't put in again (a new conversation, the panel coming back). */
  onDraftTaken?: (nonce: number) => void;
  /** Chips added from elsewhere (a piece of an App selected on its page), each once, while the question has room. */
  incoming?: { item: AttachedItem; nonce: number }[];
  /** These were taken (added, or refused for room): they aren't offered again. */
  onIncomingTaken?: (nonces: number[]) => void;
  /** In the panel beside a page (420 wide): the keyboard hint is left out, and the source chip stays on one line. */
  compact?: boolean;
  /** Whether there's a question being written: Pair beside Home's composer listens while there is. */
  onWriting?: (writing: boolean) => void;
}) {
  const [text, setText] = useState(initialText);
  const writing = text.trim().length > 0;
  const onWritingRef = useRef(onWriting);
  onWritingRef.current = onWriting;
  useEffect(() => onWritingRef.current?.(writing), [writing]);
  const [attached, setAttached] = useState<AttachedItem[]>(initialAttachments);
  // Something unsent here holds back a move elsewhere on the page's own (composer-busy.ts).
  const busyToken = useRef(Symbol("composer"));
  useEffect(() => {
    const token = busyToken.current;
    setComposerBusy(token, writing || attached.length > 0);
    return () => setComposerBusy(token, false);
  }, [writing, attached.length]);
  /** The last question put in from elsewhere: a newer one replaces it while it's untouched (a second starter). */
  const lastDraft = useRef<string | null>(null);
  const [incoming, setIncoming] = useState<{ files: File[]; nonce: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  // The page's chip, taken off for this question (it comes back for the next one).
  const focusKey = focus ? `${focus.kind}:${focus.id}` : null;
  const [focusOff, setFocusOff] = useState<string | null>(null);
  const showsFocus =
    focus !== null && focusOff !== focusKey && !attached.some((a) => a.kind === focus.kind && a.id === focus.id);
  // What's on screen goes with every question asked beside it, in the conversation already or not: it's what "this"
  // means (without it, a change asked beside one App went to another of the conversation's).
  const sendsFocus = showsFocus && focus !== null;
  // The chip counts toward the five attachments a question takes.
  const sendsFocusRef = useRef(sendsFocus);
  sendsFocusRef.current = sendsFocus;
  // Chips added from the page beside it (a piece of an App selected there): each once, while the question has room
  // (the page's chip counted). The box isn't focused for them: the person may go on selecting, and Esc there leaves
  // pick mode, never stops an answer.
  const attachedNow = useRef(attached);
  attachedNow.current = attached;
  const takenIncoming = useRef(new Set<number>());
  const onIncomingTakenRef = useRef(onIncomingTaken);
  onIncomingTakenRef.current = onIncomingTaken;
  useEffect(() => {
    const fresh = added.filter((x) => !takenIncoming.current.has(x.nonce));
    if (!fresh.length) return;
    let next = attachedNow.current;
    let full = 0;
    for (const x of fresh) {
      takenIncoming.current.add(x.nonce);
      const r = appendAttached(next, x.item, MAX_ATTACHED - (sendsFocusRef.current ? 1 : 0));
      if (r.outcome === "full") full++;
      next = r.list;
    }
    attachedNow.current = next;
    setAttached(next);
    if (full) toast.danger(`A question takes ${MAX_ATTACHED} things: take one off to add another.`);
    onIncomingTakenRef.current?.(fresh.map((x) => x.nonce));
  }, [added]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per question put in the box
  useEffect(() => {
    if (!draft) return;
    setText((now) => (!now.trim() || now === lastDraft.current ? draft.text : now));
    lastDraft.current = draft.text;
    ref.current?.focus();
    onDraftTaken?.(draft.nonce);
  }, [draft?.nonce]);
  // The box grows with the question, up to a few lines, however the text got there: typed, or put in by a starter or
  // New dashboard (a starter's ask once showed one cut-off line).
  // biome-ignore lint/correctness/useExhaustiveDependencies: sized again whenever the text changes
  useLayoutEffect(() => fitBox(ref.current), [text]);
  // And when the box first gets its width (a panel that opened after the text was put in).
  useEffect(() => {
    const box = ref.current;
    if (!box || typeof ResizeObserver === "undefined") return;
    let width = box.clientWidth;
    const seen = new ResizeObserver(() => {
      if (box.clientWidth === width) return;
      width = box.clientWidth;
      fitBox(box);
    });
    seen.observe(box);
    return () => seen.disconnect();
  }, []);
  // A new question starts in the box; a follow-up doesn't steal focus from the answer.
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);
  const source = sources.find((s) => s.id === sourceId) ?? null;
  const own = useChosenModel();
  const chosen = shared ?? own;
  // While an answer is worked on, what's sent joins it: it's read before the next step.
  // A file still being read waits: sent now, it would miss this question and land on the next.
  const [reading, setReading] = useState(0);
  const canSend = text.trim().length > 0 && !pending && source !== null && reading === 0;
  const typed = text.trim().length > 0;

  // What was just sent: a question that's refused (a spend limit, a source gone) comes back, attachments too.
  const [sent, setSent] = useState<{ text: string; attached: AttachedItem[]; focusOff: string | null } | null>(null);
  useEffect(() => {
    if (!error || !sent) return;
    setText((now) => (now ? now : sent.text));
    setAttached((now) => (now.length ? now : sent.attached));
    // A chip taken off stays off for the question that comes back: it wasn't meant to go with it.
    setFocusOff(sent.focusOff);
    setSent(null);
  }, [error, sent]);
  const send = () => {
    if (!canSend) return;
    onSubmit(text.trim(), chosen.value, sendsFocus && focus ? [focus, ...attached] : attached);
    setSent({ text: text.trim(), attached, focusOff });
    setText("");
    setAttached([]);
    // The page's chip is offered again for the next question.
    setFocusOff(null);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
    // Esc stops the answer, not a follow-up being typed (it may be closing a picker).
    if (e.key === "Escape" && running && !typed) onStop?.();
  };

  return (
    // A container: what's beside the question gives way by the composer's own width (a phone, the panel).
    <div className="@container/composer flex flex-col gap-1.5">
      {/* A file or image dropped anywhere on the box goes with the question, as the paperclip's would. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a drop target; the paperclip is the keyboard's way in */}
      <div
        onDragOver={(e) => {
          if (![...e.dataTransfer.types].includes("Files")) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={(e) => {
          setDragging(false);
          const files = [...e.dataTransfer.files];
          if (!files.length) return;
          e.preventDefault();
          setIncoming({ files, nonce: Date.now() });
        }}
        className={`flex flex-col gap-2 rounded-3xl border bg-surface pt-3 pr-3 pb-2.5 pl-3.5 focus-within:border-accent ${dragging ? "border-accent bg-accent-soft" : "border-border-secondary"}`}
      >
        {showsFocus && focus ? (
          <div className="flex min-w-0 flex-wrap gap-1.5">
            <FocusChip item={focus} onRemove={() => setFocusOff(focusKey)} />
            <AttachmentChips
              items={attached}
              onRemove={(a) => setAttached((list) => list.filter((x) => !(x.kind === a.kind && x.id === a.id)))}
            />
          </div>
        ) : (
          <AttachmentChips
            items={attached}
            onRemove={(a) => setAttached((list) => list.filter((x) => !(x.kind === a.kind && x.id === a.id)))}
          />
        )}
        <textarea
          ref={ref}
          onPaste={(e) => {
            // A screenshot or file pasted goes with the question; pasted text stays text.
            const files = [...e.clipboardData.files];
            if (!files.length) return;
            e.preventDefault();
            setIncoming({ files, nonce: Date.now() });
          }}
          rows={1}
          value={text}
          aria-label="Your question"
          placeholder={running ? "Add to your question. OpenDash reads it before its next step." : placeholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          className="resize-none bg-transparent text-lead text-foreground outline-none placeholder:text-muted-tertiary"
        />
        <div className="flex items-center justify-between gap-3">
          {/* No source picker: the analyst reads every source the person can. Only the sample
              is said, so numbers that aren't theirs never look like theirs. */}
          {source?.sample ? (
            <span className="flex items-center gap-1.5 whitespace-nowrap rounded-md border border-border px-2 py-0.5 text-small text-accent-soft-foreground">
              <Database className="size-3 shrink-0" aria-hidden />
              Sample data
            </span>
          ) : null}
          {source ? (
            <AttachPicker
              connectionId={source.id}
              attached={sendsFocus && focus ? [focus, ...attached] : attached}
              onToggle={(item) =>
                // The page's chip, chosen in the picker, is taken off as its own x would.
                sendsFocus && focus && item.kind === focus.kind && item.id === focus.id
                  ? setFocusOff(focusKey)
                  : setAttached((list) =>
                      list.some((x) => x.kind === item.kind && x.id === item.id)
                        ? list.filter((x) => !(x.kind === item.kind && x.id === item.id))
                        : [...list, item],
                    )
              }
            />
          ) : null}
          <ReferencePicker
            incoming={incoming}
            attached={sendsFocus && focus ? [focus, ...attached] : attached}
            onAdd={(item) => setAttached((list) => [...list, item])}
            onReading={setReading}
          />
          <ChatModelPicker chosen={chosen} />
          <span className="ms-auto flex shrink-0 items-center gap-2 whitespace-nowrap text-micro text-muted-tertiary">
            {compact ? null : (
              <span className="hidden @md/composer:inline">
                {running ? (typed ? "↵ to add" : "Esc to stop") : "↵ to send"}
              </span>
            )}
            {running && !typed ? (
              <Button isIconOnly size="sm" aria-label="Stop" onPress={onStop}>
                <Square className="size-3.5 fill-current" aria-hidden />
              </Button>
            ) : (
              <Button isIconOnly size="sm" aria-label="Send" isDisabled={!canSend} isPending={pending} onPress={send}>
                <ArrowUp className="size-4" aria-hidden />
              </Button>
            )}
          </span>
        </div>
      </div>
      {source?.failing && !error ? (
        <p className="flex items-start gap-2 rounded-xl bg-warning-soft px-3.5 py-2.5 text-small text-warning-soft-foreground">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {source.name} can't connect: {source.failing} An admin fixes it under Data.
        </p>
      ) : null}
      {error ? (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-xl bg-danger-soft px-3.5 py-2.5 text-small text-danger-soft-foreground"
        >
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {error}
        </p>
      ) : null}
    </div>
  );
}

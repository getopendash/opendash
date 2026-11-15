"use client";

import { usePathname } from "next/navigation";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { AttachedItem } from "@/components/ask/attach-picker";

/** What the page shows, for the composer's "on screen" chip: sending it attaches it. */
export interface PanelFocus {
  item: AttachedItem;
  /** Where a new conversation about it starts: a definition's source. */
  connectionId: string | null;
}

type View = "conversation" | "trace";

interface PanelState {
  open: boolean;
  /** Someone opened or closed it in this tab: from then on it does so smoothly (not when a reload restores it). */
  animate: boolean;
  threadId: string | null;
  view: View;
  /** A question to start from, put in the composer once (a tile's "Make it rolling"). */
  draft: { text: string; nonce: number } | null;
  /**
   * Chips to add to the question being written, each once (a piece of an App selected on its page): the composer
   * takes them in order and says when it took them.
   */
  incoming: { item: AttachedItem; nonce: number }[];
  /** Adds a chip to the question in the panel, opening it on the conversation it shows (a new one when none). */
  attach: (item: AttachedItem) => void;
  takeIncoming: (nonces: number[]) => void;
  /** What it was opened to start (New dashboard, a starter: its intro says so); every open sets it again. */
  intent: "dashboard" | null;
  focus: PanelFocus | null;
  /** Where a new conversation starts when the page names no source of its own (an insight's, a review's). */
  startSource: string | null;
  /** The run whose trace the panel shows. */
  traceRunId: string | null;
  /** Opens it: on a conversation (null for a new one), with a question to start from, on a view, from a source. */
  show: (options?: {
    threadId?: string | null;
    text?: string;
    view?: View;
    connectionId?: string | null;
    runId?: string;
    intent?: "dashboard";
  }) => void;
  close: () => void;
  toggle: () => void;
  setThread: (threadId: string | null) => void;
  setView: (view: View) => void;
  /** The question to start from was put in a composer: it isn't put in again (a new conversation, coming back). */
  takeDraft: (nonce: number) => void;
  setFocus: (focus: PanelFocus | null, owner: symbol) => void;
  clearFocus: (owner: symbol) => void;
}

const PanelContext = createContext<PanelState | null>(null);

const KEY = "opendash.panel";

/** The analyst beside every page: one conversation, kept open while its person moves around. */
export function PanelProvider({ scope, children }: { scope: string; children: ReactNode }) {
  const pathname = usePathname();
  const onAsk = pathname.startsWith("/ask/") || pathname === "/ask";
  const key = `${KEY}.${scope}`;
  const [open, setOpen] = useState(false);
  const [animate, setAnimate] = useState(false);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [view, setView] = useState<View>("conversation");
  const [draft, setDraft] = useState<PanelState["draft"]>(null);
  const [incoming, setIncoming] = useState<PanelState["incoming"]>([]);
  const nextIncoming = useRef(0);
  const [intent, setIntent] = useState<PanelState["intent"]>(null);
  const [focus, setFocusState] = useState<PanelFocus | null>(null);
  const [startSource, setStartSource] = useState<string | null>(null);
  const [traceRunId, setTraceRunId] = useState<string | null>(null);
  const focusOwner = useRef<symbol | null>(null);

  // Where it was, for this browser tab: a reload keeps the conversation beside the page. Written by what changes it
  // (not an effect on the state, which would write the defaults over it on the first render), read per workspace.
  const kept = useRef({ open: false, threadId: null as string | null });
  const keyNow = useRef(key);
  keyNow.current = key;
  const place = useCallback((next: { open?: boolean; threadId?: string | null }) => {
    kept.current = { ...kept.current, ...next };
    if (next.open !== undefined) {
      setAnimate(true);
      setOpen(next.open);
    }
    if (next.threadId !== undefined) setThreadId(next.threadId);
    try {
      sessionStorage.setItem(keyNow.current, JSON.stringify(kept.current));
    } catch {
      // Not kept; fine.
    }
  }, []);
  useEffect(() => {
    let stored: { open?: boolean; threadId?: string } | null = null;
    try {
      stored = JSON.parse(sessionStorage.getItem(key) ?? "null");
    } catch {
      // Storage can be unavailable (a private window): it starts closed.
    }
    // Another workspace's (an org switch) starts from its own, or closed.
    kept.current = { open: Boolean(stored?.open), threadId: stored?.threadId ?? null };
    setOpen(kept.current.open);
    setThreadId(kept.current.threadId);
  }, [key]);

  const show = useCallback<PanelState["show"]>(
    (options = {}) => {
      // A new conversation starts where this call says, or where its page's chip does: never the last page's source.
      if (options.connectionId !== undefined || options.threadId === null) setStartSource(options.connectionId ?? null);
      setView(options.view ?? "conversation");
      if (options.runId) setTraceRunId(options.runId);
      setDraft(options.text ? { text: options.text, nonce: Date.now() } : null);
      setIntent(options.intent ?? null);
      place({ open: true, ...(options.threadId !== undefined ? { threadId: options.threadId } : {}) });
    },
    [place],
  );
  const takeDraft = useCallback((nonce: number) => setDraft((d) => (d && d.nonce === nonce ? null : d)), []);
  // A chip from the page goes on the question as it is: the conversation shown stays (it's about the page already,
  // or the person chose it), and so does anything typed.
  const attach = useCallback(
    (item: AttachedItem) => {
      nextIncoming.current += 1;
      const nonce = nextIncoming.current;
      setIncoming((list) => [...list, { item, nonce }]);
      setView("conversation");
      place({ open: true });
    },
    [place],
  );
  const takeIncoming = useCallback(
    (nonces: number[]) => setIncoming((list) => list.filter((x) => !nonces.includes(x.nonce))),
    [],
  );
  const toggle = useCallback(() => place({ open: !kept.current.open }), [place]);

  // ⌘J (Ctrl+J): the analyst, from anywhere but Ask, where the page is the conversation.
  useEffect(() => {
    if (onAsk) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "j") {
        e.preventDefault();
        setView("conversation");
        place({ open: !kept.current.open });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onAsk, place]);

  const focusNow = useRef<PanelFocus | null>(null);
  const setFocus = useCallback((next: PanelFocus | null, owner: symbol) => {
    focusOwner.current = owner;
    focusNow.current = next;
    setFocusState(next);
  }, []);
  const clearFocus = useCallback((owner: symbol) => {
    if (focusOwner.current !== owner) return;
    focusOwner.current = null;
    focusNow.current = null;
    setFocusState(null);
  }, []);

  const value = useMemo<PanelState>(
    () => ({
      open,
      animate,
      threadId,
      view,
      draft,
      incoming,
      attach,
      takeIncoming,
      intent,
      focus,
      startSource,
      traceRunId,
      show,
      close: () => place({ open: false }),
      toggle,
      setThread: (id: string | null) => {
        place({ threadId: id });
        setDraft(null);
        setIntent(null);
      },
      takeDraft,
      setView,
      setFocus,
      clearFocus,
    }),
    [
      open,
      animate,
      threadId,
      view,
      draft,
      incoming,
      attach,
      takeIncoming,
      intent,
      focus,
      startSource,
      traceRunId,
      show,
      toggle,
      takeDraft,
      setFocus,
      clearFocus,
      place,
    ],
  );
  return <PanelContext.Provider value={value}>{children}</PanelContext.Provider>;
}

export function usePanel(): PanelState {
  const state = useContext(PanelContext);
  if (!state) throw new Error("usePanel must be used inside <PanelProvider>");
  return state;
}

/** The panel when there is one: a conversation drawn outside the app's shell (a shared link) has none. */
export function usePanelIfAny(): PanelState | null {
  return useContext(PanelContext);
}

/**
 * Names what the page shows: the composer offers it as a chip, sent with the next question so the analyst
 * reads it. Cleared when the page goes; null names nothing.
 */
export function useFocus(focus: PanelFocus | null) {
  const panel = useContext(PanelContext);
  const key = focus ? `${focus.item.kind}:${focus.item.id}:${focus.item.title}:${focus.connectionId ?? ""}` : "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when what the page shows changes
  useEffect(() => {
    if (!panel || !focus) return;
    const owner = Symbol("focus");
    panel.setFocus(focus, owner);
    return () => panel.clearFocus(owner);
  }, [key, panel?.setFocus, panel?.clearFocus]);
}

"use client";

import { Modal } from "@heroui/react";
import type { WorkspaceSearch } from "@opendash/core";
import { StatusBadge } from "@opendash/ui";
import {
  BookA,
  BookOpen,
  Database,
  ListChecks,
  type LucideIcon,
  MessageSquare,
  Search,
  ShieldCheck,
  Sigma,
  Table2,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { searchAction } from "@/app/(app)/search/actions";
import { hitHref, KIND_LABEL } from "@/lib/search-words";

/** The event the sidebar's Search button sends (the sidebar renders twice; the palette once). */
export const OPEN_SEARCH = "opendash:search";

const ICON: Record<string, LucideIcon> = {
  metric: Sigma,
  dataset: Database,
  term: BookA,
  guide: BookOpen,
  verified_query: ShieldCheck,
  skill: ListChecks,
  table: Table2,
  conversation: MessageSquare,
};

type Item = {
  key: string;
  group: string;
  icon: LucideIcon;
  title: string;
  meta: string;
  href: string;
  verified: boolean;
};

const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** The palette's rows, in its groups' order. */
function itemsOf(r: WorkspaceSearch | null): Item[] {
  if (!r) return [];
  return [
    ...r.knowledge.map((h) => ({
      key: `${h.kind}:${h.id}`,
      group: "Definitions",
      icon: ICON[h.kind] ?? BookOpen,
      title: h.title,
      meta: KIND_LABEL[h.kind],
      href: hitHref(h),
      verified: h.status === "verified",
    })),
    ...r.tables.map((h) => ({
      key: `table:${h.id}`,
      group: "Tables",
      icon: Table2,
      title: h.title,
      meta: h.sourceName,
      href: hitHref(h),
      verified: false,
    })),
    ...r.conversations.map((c) => ({
      key: `thread:${c.id}`,
      group: "Conversations",
      icon: MessageSquare,
      title: c.title,
      meta: `${c.mine ? "You" : "Shared"} · ${DAY.format(new Date(c.at))}`,
      href: `/ask/${c.id}`,
      verified: false,
    })),
  ];
}

/**
 * Search the workspace (⌘K, or the sidebar's Search): knowledge, tables and conversations the person can open. Arrow keys move, Enter opens.
 */
export function SearchPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<WorkspaceSearch | null>(null);
  const [active, setActive] = useState(0);
  const asked = useRef(0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_SEARCH, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_SEARCH, onOpen);
    };
  }, []);
  // Asked a moment after typing stops; a slower earlier answer never replaces a later one.
  useEffect(() => {
    const text = q.trim();
    const n = ++asked.current;
    if (!text) {
      setResults(null);
      return;
    }
    const timer = setTimeout(() => {
      void searchAction(text).then((r) => {
        if (n === asked.current) {
          setResults(r);
          setActive(0);
        }
      });
    }, 180);
    return () => clearTimeout(timer);
  }, [q]);
  const items = useMemo(() => itemsOf(results), [results]);
  const go = (item: Item | undefined) => {
    if (!item) return;
    setOpen(false);
    setQ("");
    router.push(item.href);
  };
  return (
    <Modal>
      <Modal.Backdrop
        isOpen={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) setQ("");
        }}
      >
        <Modal.Container size="lg" placement="top">
          <Modal.Dialog aria-label="Search" className="overflow-hidden p-0">
            <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
              <Search className="size-4 shrink-0 text-muted" aria-hidden />
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setActive((i) => Math.min(i + 1, Math.max(items.length - 1, 0)));
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setActive((i) => Math.max(i - 1, 0));
                  } else if (e.key === "Enter") {
                    e.preventDefault();
                    go(items[active]);
                  }
                }}
                placeholder="Search knowledge, tables, conversations…"
                aria-label="Search"
                className="min-w-0 flex-1 bg-transparent text-lead outline-none placeholder:text-muted-tertiary"
              />
              <kbd className="rounded-sm border border-border px-1.5 font-sans text-micro text-muted">esc</kbd>
            </div>
            <ul aria-label="Results" className="flex max-h-96 flex-col overflow-y-auto p-2">
              {items.map((item, i) => (
                <li key={item.key} className="flex flex-col">
                  {i === 0 || items[i - 1]?.group !== item.group ? (
                    <span className="px-2.5 pt-2 pb-1 text-small font-medium text-muted-tertiary">{item.group}</span>
                  ) : null}
                  <button
                    type="button"
                    onMouseEnter={() => setActive(i)}
                    onClick={() => go(item)}
                    aria-current={i === active ? "true" : undefined}
                    className={`flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left ${i === active ? "bg-default" : ""}`}
                  >
                    <item.icon className="size-3.5 shrink-0 text-muted" aria-hidden />
                    <span className="min-w-0 truncate text-body">{item.title}</span>
                    <span className="shrink-0 text-small text-muted-tertiary">{item.meta}</span>
                    <span className="flex-1" />
                    {item.verified ? <StatusBadge status="verified" /> : null}
                  </button>
                </li>
              ))}
              {q.trim() && results && !items.length ? (
                <li className="px-2.5 py-6 text-center text-body text-muted">Nothing matches “{q.trim()}”.</li>
              ) : null}
              {!q.trim() ? (
                <li className="px-2.5 py-6 text-center text-small text-muted-tertiary">
                  Knowledge, tables and conversations you can open.
                </li>
              ) : null}
            </ul>
            <div className="flex items-center gap-4 border-t border-border bg-surface-secondary px-4 py-2 text-small text-muted-tertiary">
              <span>↑ ↓ to move</span>
              <span>↵ to open</span>
            </div>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}

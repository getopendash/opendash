"use client";

import { ListBox, SearchField, Select } from "@heroui/react";
import { CircleDot, Folder } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { type HistoryParams, historyHref, type Scope } from "@/lib/ask-filters";
import { THREAD_STATE_LABELS } from "@/lib/thread-status";

const SCOPES: { id: Scope; label: string }[] = [
  { id: "all", label: "All" },
  { id: "mine", label: "Mine" },
  { id: "shared", label: "Shared with me" },
  { id: "starred", label: "Starred" },
];
const ANY = "any";

/** The conversations list's toolbar: search, whose conversations, a project and a status. Every setting lives in the URL. */
export function HistoryToolbar({
  params,
  projects,
}: {
  params: HistoryParams;
  projects: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [q, setQ] = useState(params.q);
  // The search box follows the URL (back and forward, "Clear search and filters").
  const typed = useRef(params.q);
  useEffect(() => {
    if (params.q !== typed.current) {
      typed.current = params.q;
      setQ(params.q);
    }
  }, [params.q]);
  // Typing settles for a moment before the list follows.
  useEffect(() => {
    if (q.trim() === params.q.trim()) return;
    const timer = setTimeout(() => {
      typed.current = q;
      router.replace(historyHref(params, { q }));
    }, 300);
    return () => clearTimeout(timer);
  }, [q, params, router]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <SearchField aria-label="Search questions and answers" value={q} onChange={setQ} className="w-full @xl/page:w-80">
        <SearchField.Group>
          <SearchField.SearchIcon />
          <SearchField.Input placeholder="Search questions and answers…" />
          <SearchField.ClearButton />
        </SearchField.Group>
      </SearchField>
      <nav aria-label="Whose conversations" className="flex items-center gap-0.5 rounded-xl bg-surface-secondary p-0.5">
        {SCOPES.map((s) => {
          const active = params.scope === s.id;
          return (
            <Link
              key={s.id}
              href={historyHref(params, { scope: s.id })}
              aria-current={active ? "page" : undefined}
              className={`rounded-lg px-2.5 py-1 text-small ${active ? "bg-surface font-medium" : "text-muted hover:text-foreground"}`}
            >
              {s.label}
            </Link>
          );
        })}
      </nav>
      {projects.length ? (
        <Select
          aria-label="Project"
          value={params.project ?? ANY}
          onChange={(key) => router.push(historyHref(params, { project: key && key !== ANY ? String(key) : null }))}
          className="w-44"
        >
          <Select.Trigger className="gap-1.5">
            <Folder className="size-3.5 shrink-0 text-muted" aria-hidden />
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              <ListBox.Item id={ANY} textValue="Any project">
                Any project
                <ListBox.ItemIndicator />
              </ListBox.Item>
              {projects.map((p) => (
                <ListBox.Item key={p.id} id={p.id} textValue={p.name}>
                  {p.name}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
      ) : null}
      <Select
        aria-label="Status"
        value={params.state ?? ANY}
        onChange={(key) =>
          router.push(
            historyHref(params, {
              state: key && key !== ANY ? (String(key) as keyof typeof THREAD_STATE_LABELS) : null,
            }),
          )
        }
        className="w-44"
      >
        <Select.Trigger className="gap-1.5">
          <CircleDot className="size-3.5 shrink-0 text-muted" aria-hidden />
          <Select.Value />
          <Select.Indicator />
        </Select.Trigger>
        <Select.Popover>
          <ListBox>
            <ListBox.Item id={ANY} textValue="Any status">
              Any status
              <ListBox.ItemIndicator />
            </ListBox.Item>
            {Object.entries(THREAD_STATE_LABELS).map(([id, s]) => (
              <ListBox.Item key={id} id={id} textValue={s.label}>
                {s.label}
                <ListBox.ItemIndicator />
              </ListBox.Item>
            ))}
          </ListBox>
        </Select.Popover>
      </Select>
    </div>
  );
}

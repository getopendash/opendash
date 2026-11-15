"use client";

import { Button, SearchField, Spinner } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { CircleAlert, CircleHelp, CircleX, MessageSquare, SquarePen } from "lucide-react";
import Link from "next/link";
import { Fragment, useEffect, useState } from "react";
import { apiQueries } from "@/lib/api";
import { whenGroup } from "@/lib/ask-filters";
import { ago } from "@/lib/format";
import { threadStatus } from "@/lib/thread-status";

function StatusIcon({ tone }: { tone: ReturnType<typeof threadStatus>["tone"] }) {
  if (tone === "running") return <Spinner size="sm" aria-hidden />;
  if (tone === "warn") return <CircleHelp className="size-4 text-warning" aria-hidden />;
  if (tone === "danger") return <CircleX className="size-4 text-danger" aria-hidden />;
  return <MessageSquare className="size-4 text-muted-tertiary" aria-hidden />;
}

/**
 * A conversation's Threads pane: search, Mine or All, the conversations grouped by day with the open one
 * marked, refreshed while any is working.
 */
export function ThreadsPane({ activeId, now }: { activeId: string | null; now: number }) {
  const [scope, setScope] = useState<"mine" | "all">("all");
  const [typed, setTyped] = useState("");
  const [q, setQ] = useState("");
  // The list follows the search once typing pauses.
  useEffect(() => {
    const timer = setTimeout(() => setQ(typed.trim()), 250);
    return () => clearTimeout(timer);
  }, [typed]);
  const { data, error } = useQuery({
    ...apiQueries.threads.list.queryOptions({ input: { scope, limit: 50, ...(q ? { q } : {}) } }),
    refetchInterval: (q) => (q.state.data?.some((t) => threadStatus(t).tone === "running") ? 2_000 : false),
  });
  return (
    <nav aria-label="Conversations" className="flex h-full w-72 shrink-0 flex-col border-r border-border">
      <header className="flex h-12 shrink-0 items-center justify-between gap-2 px-3">
        <h2 className="text-body font-semibold">Threads</h2>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" onPress={() => setScope(scope === "all" ? "mine" : "all")}>
            {scope === "all" ? "All" : "Mine"}
          </Button>
          <Link
            href="/ask/new"
            aria-label="New question"
            className="flex size-7 items-center justify-center rounded-lg text-muted hover:bg-default"
          >
            <SquarePen className="size-4" aria-hidden />
          </Link>
        </div>
      </header>
      <div className="px-3 pb-2">
        <SearchField aria-label="Search threads" value={typed} onChange={setTyped} fullWidth>
          <SearchField.Group>
            <SearchField.SearchIcon />
            <SearchField.Input placeholder="Search threads" />
            <SearchField.ClearButton />
          </SearchField.Group>
        </SearchField>
      </div>
      <ul className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-3">
        {error ? (
          <li className="flex items-center gap-2 px-2 py-2 text-small text-danger">
            <CircleAlert className="size-3.5" aria-hidden />
            Couldn't load conversations.
          </li>
        ) : null}
        {data?.length === 0 ? (
          <li className="px-2 py-2 text-small text-muted">
            {q ? `No conversations match “${q}”.` : "No conversations yet."}
          </li>
        ) : null}
        {data?.map((t, i) => {
          const status = threadStatus(t);
          const active = t.id === activeId;
          const group = whenGroup(t.lastMessageAt ?? t.createdAt, now);
          const previous = i ? data[i - 1] : undefined;
          const heading = !previous || whenGroup(previous.lastMessageAt ?? previous.createdAt, now) !== group;
          return (
            <Fragment key={t.id}>
              {heading ? (
                <li className="px-2 pt-3 pb-1 text-micro font-medium text-muted-tertiary first:pt-1">{group}</li>
              ) : null}
              <li>
                <Link
                  href={`/ask/${t.id}`}
                  aria-current={active ? "page" : undefined}
                  className={`flex gap-2.5 rounded-xl px-2 py-2 ${active ? "bg-default" : "hover:bg-default"}`}
                >
                  <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
                    <StatusIcon tone={status.tone} />
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-body">{t.title}</span>
                    <span className="truncate text-small text-muted-tertiary">
                      {t.mine
                        ? `${status.label}${t.channel === "slack" ? " · From Slack" : ""}${t.visibility === "org" ? " · Shared" : t.visibility === "project" ? " · In a project" : ""} · ${t.sourceName}`
                        : `Shared by ${t.author ?? "a teammate"}`}{" "}
                      · {ago(t.lastMessageAt ?? t.createdAt, now)}
                    </span>
                  </span>
                </Link>
              </li>
            </Fragment>
          );
        })}
      </ul>
      <footer className="px-4 py-3">
        <Link href={q ? `/ask?q=${encodeURIComponent(q)}` : "/ask"} className="text-small text-link hover:underline">
          {q ? "See every match" : "View all threads"}
        </Link>
      </footer>
    </nav>
  );
}

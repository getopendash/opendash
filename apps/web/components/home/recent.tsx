import type { ThreadSummary } from "@opendash/core";
import { MessageSquare } from "lucide-react";
import Link from "next/link";
import { ago } from "@/lib/format";
import { threadStatus } from "@/lib/thread-status";

/** Home's Recent: the latest conversations (dashboards and reports join them when they exist). */
export function Recent({ threads, now }: { threads: ThreadSummary[]; now: number }) {
  return (
    <section className="flex flex-col gap-2 rounded-2xl border border-border p-4 @5xl/page:w-96 @5xl/page:shrink-0">
      <header className="flex items-center justify-between">
        <h2 className="text-body font-medium">Recent</h2>
        <Link href="/ask" className="text-small text-link hover:underline">
          View all
        </Link>
      </header>
      {threads.length ? (
        <ul className="flex flex-col">
          {threads.map((t) => (
            <li key={t.id}>
              <Link href={`/ask/${t.id}`} className="flex gap-3 rounded-xl px-1.5 py-2 hover:bg-default">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-secondary">
                  <MessageSquare className="size-4 text-muted" aria-hidden />
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-body">{t.title}</span>
                  <span className="truncate text-small text-muted-tertiary">
                    {threadStatus(t).label}
                    {t.channel === "slack" ? " · From Slack" : ""} · {ago(t.lastMessageAt ?? t.createdAt, now)}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="py-6 text-center text-small text-muted">Questions you ask show here.</p>
      )}
    </section>
  );
}

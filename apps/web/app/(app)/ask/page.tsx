import { buttonVariants } from "@heroui/react";
import { SearchX, SquarePen, X } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { HistoryPager } from "@/components/ask/history-pager";
import { HistoryToolbar } from "@/components/ask/history-toolbar";
import { ThreadsTable } from "@/components/ask/threads-table";
import { TopBar } from "@/components/shell/top-bar";
import { historyHref, isNarrowed, parseHistory } from "@/lib/ask-filters";
import { historyFor } from "@/lib/ask-history";
import { requireTenant } from "@/lib/auth";
import { projectChoices } from "@/lib/project-data";
import { THREAD_STATE_LABELS } from "@/lib/thread-status";

export const metadata: Metadata = { title: "Ask · OpenDash" };

/** The conversations, yours and those shared with you, searched and filtered, with how each ended. */
export default async function AskPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [sp, viewer] = await Promise.all([searchParams, requireTenant()]);
  const params = parseHistory(sp);
  const [{ threads, total }, projects] = await Promise.all([
    historyFor(viewer.ctx.orgId, viewer.user.id, params),
    projectChoices(viewer),
  ]);
  // Past the last page (the list shrank): back to the first.
  if (!threads.length && params.page > 1) redirect(historyHref(params, { page: 1 }));
  const narrowed = isNarrowed(params);
  const project = projects.find((p) => p.id === params.project);
  const what = [
    params.q.trim() ? `match “${params.q.trim()}”` : null,
    project ? `in ${project.name}` : null,
    params.state ? `with the status “${THREAD_STATE_LABELS[params.state].label}”` : null,
  ].filter(Boolean);
  // Nothing matches, in a panel where the table was.
  const empty = narrowed ? (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-border px-6 py-16 text-center">
      <SearchX className="size-5 text-muted-tertiary" aria-hidden />
      <p className="text-body font-medium">No conversations {what.join(" ")}</p>
      <p className="text-small text-muted">
        Search looks in titles, questions and answers. Try fewer words, or clear the filters.
      </p>
      <Link
        href={historyHref(params, { q: "", project: null, state: null })}
        className={`${buttonVariants({ size: "sm", variant: "outline" })} gap-1`}
      >
        <X className="size-3.5" aria-hidden />
        Clear search and filters
      </Link>
    </div>
  ) : (
    <p className="rounded-2xl border border-border py-8 text-center text-body text-muted">
      {params.scope === "shared"
        ? "Nobody has shared a conversation with you yet."
        : params.scope === "starred"
          ? "Star a conversation to keep it here."
          : "No questions yet."}
    </p>
  );
  return (
    <>
      <TopBar
        crumbs={[{ label: "Ask" }]}
        action={
          <Link href="/ask/new" className={`${buttonVariants({ size: "sm" })} gap-1`}>
            <SquarePen className="size-3.5" aria-hidden />
            New question
          </Link>
        }
      />
      <div className="flex-1 overflow-y-auto px-8 pt-8 pb-16">
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-1.5">
            <h1 className="text-display">Ask</h1>
            <p className="text-body text-muted">
              Every question asked here, with how each answer ended and the numbers behind it.
            </p>
          </div>
          <HistoryToolbar params={params} projects={projects} />
          {threads.length ? (
            <ThreadsTable
              threads={threads}
              projects={projects}
              now={Date.now()}
              footer={<HistoryPager params={params} shown={threads.length} total={total} />}
            />
          ) : (
            empty
          )}
        </div>
      </div>
    </>
  );
}

"use client";

import { Button, toast } from "@heroui/react";
import type { FeedbackReport } from "@opendash/core";
import { Flag, MessageSquare, Sigma, Table2, ThumbsDown } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { setReportStatusAction } from "@/app/(app)/knowledge/actions";
import { ago } from "@/lib/format";

const REASON: Record<string, string> = {
  wrong_number: "a number is wrong",
  wrong_definition: "wrong definition",
  missing_context: "missing context",
  misread_question: "misread the question",
  other: "something else",
};

/** One report (Knowledge → Feedback, a definition's page): what was said, about which answer, and what it used. */
export function FeedbackReportCard({
  report,
  now,
  canReview,
  compact = false,
}: {
  report: FeedbackReport;
  now: number;
  canReview: boolean;
  compact?: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const number = report.kind === "wrong_number";
  const set = (status: "new" | "ignored") =>
    start(async () => {
      const r = await setReportStatusAction(report.id, status);
      if (r.message) toast.danger(r.message);
      router.refresh();
    });
  return (
    <li className={`flex flex-col gap-2 ${compact ? "py-2" : "rounded-2xl border border-border p-4"}`}>
      <div className="flex items-start gap-2.5">
        {number ? (
          <Flag className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
        ) : (
          <ThumbsDown className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-body">
            {number ? (
              <>
                A number was reported as wrong{" "}
                <span className="font-mono text-small text-muted">{report.claimKey}</span>
              </>
            ) : (
              <>Not right{report.reasonCode ? `: ${REASON[report.reasonCode] ?? report.reasonCode}` : ""}</>
            )}
          </span>
          {report.threadId ? (
            <Link
              href={`/ask/${report.threadId}`}
              className="flex items-center gap-1.5 truncate text-small text-link hover:underline"
            >
              <MessageSquare className="size-3 shrink-0" aria-hidden />
              {report.question ?? report.threadTitle}
            </Link>
          ) : (
            <span className="flex items-center gap-1.5 text-small text-muted-tertiary">
              <MessageSquare className="size-3 shrink-0" aria-hidden />
              In a private conversation
            </span>
          )}
        </div>
        <span className="shrink-0 text-small text-muted-tertiary">
          {report.mine ? "You" : "A teammate"} · {ago(report.createdAt, now)}
        </span>
      </div>
      {report.correction || report.comment ? (
        <div className="ms-6.5 flex flex-col gap-1 border-s-2 border-border ps-3 text-body">
          {report.correction ? (
            <span>
              <span className="text-muted">Should be: </span>
              {report.correction}
            </span>
          ) : null}
          {report.comment ? <span className="text-muted">“{report.comment}”</span> : null}
        </div>
      ) : null}
      {(!compact && report.definitions.length) || canReview ? (
        <div className="ms-6.5 flex flex-wrap items-center gap-2">
          {!compact
            ? report.definitions.map((d) => (
                <Link
                  key={d.id}
                  href={`/knowledge/${d.kind === "metric" ? "metrics" : "datasets"}/${d.id}`}
                  className="flex items-center gap-1 rounded-lg border border-border px-2 py-0.5 text-small hover:bg-default"
                >
                  {d.kind === "metric" ? (
                    <Sigma className="size-3 text-muted" aria-hidden />
                  ) : (
                    <Table2 className="size-3 text-muted" aria-hidden />
                  )}
                  {d.title}
                </Link>
              ))
            : null}
          <span className="flex-1" />
          {canReview ? (
            <Button
              size="sm"
              variant="ghost"
              isPending={pending}
              onPress={() => set(report.status === "ignored" ? "new" : "ignored")}
            >
              {report.status === "ignored" ? "Reopen" : "Dismiss"}
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

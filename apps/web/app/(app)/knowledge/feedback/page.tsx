import { listReports } from "@opendash/core";
import { withTenant } from "@opendash/db";
import { MessageSquareWarning } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { FeedbackReportCard } from "@/components/knowledge/feedback-report";
import { TopBar } from "@/components/shell/top-bar";
import { requireTenant } from "@/lib/auth";
import { canVerify } from "@/lib/knowledge";

export const metadata: Metadata = { title: "Feedback · OpenDash" };

/**
 * Knowledge → Feedback: answers people said weren't right, and numbers reported as wrong, with the definitions each
 * answer used, so a wrong definition is fixed where it lives. The Curator will route these into proposals later.
 */
export default async function FeedbackPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const [{ status }, viewer] = await Promise.all([searchParams, requireTenant()]);
  // Reviewing feedback is an owner's or admin's job.
  if (!canVerify(viewer.role)) redirect("/knowledge/metrics");
  const dismissed = status === "dismissed";
  const reports = await withTenant(viewer.ctx, (tx) =>
    listReports(tx, { orgId: viewer.ctx.orgId, userId: viewer.user.id }, { status: dismissed ? "ignored" : "new" }),
  );
  const now = Date.now();
  return (
    <>
      <TopBar crumbs={[{ label: "Knowledge", href: "/knowledge" }, { label: "Feedback" }]} />
      <div className="flex-1 overflow-y-auto px-8 pt-8 pb-16">
        <div className="flex max-w-reading flex-col gap-6">
          <div className="flex flex-col gap-1.5">
            <h1 className="text-display">Feedback</h1>
            <p className="text-body text-muted">
              Answers your team said weren't right, and numbers they reported, with the definitions each answer used.
              Fix the definition, then dismiss the report.
            </p>
          </div>
          <nav aria-label="Which reports" className="flex gap-1">
            {[
              { href: "/knowledge/feedback", label: "Open", active: !dismissed },
              { href: "/knowledge/feedback?status=dismissed", label: "Dismissed", active: dismissed },
            ].map((t) => (
              <Link
                key={t.label}
                href={t.href}
                aria-current={t.active ? "page" : undefined}
                className={`rounded-lg px-2.5 py-1 text-body ${t.active ? "bg-default font-medium" : "text-muted hover:bg-default"}`}
              >
                {t.label}
              </Link>
            ))}
          </nav>
          {reports.length ? (
            <ul className="flex flex-col gap-3">
              {reports.map((r) => (
                <FeedbackReportCard key={r.id} report={r} now={now} canReview />
              ))}
            </ul>
          ) : (
            <div className="flex flex-col items-center gap-2 rounded-2xl border border-border py-16 text-center">
              <MessageSquareWarning className="size-5 text-muted" aria-hidden />
              <p className="text-body">{dismissed ? "Nothing dismissed." : "No open reports."}</p>
              <p className="text-small text-muted">When someone says an answer isn't right, it shows here.</p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

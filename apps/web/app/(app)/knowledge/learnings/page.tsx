import { listTopics, type TopicSummary } from "@opendash/core";
import { withTenant } from "@opendash/db";
import { BookCheck, Lightbulb, LoaderCircle, Undo2 } from "lucide-react";
import type { Metadata } from "next";
import { ListRow } from "@/components/knowledge/proposal-detail";
import { TopBar } from "@/components/shell/top-bar";
import { requireTenant } from "@/lib/auth";
import { count } from "@/lib/format";
import { canVerify } from "@/lib/knowledge";
import { TOPIC_STATE } from "@/lib/topics";

export const metadata: Metadata = { title: "Learnings · OpenDash" };

const icon = (t: TopicSummary) =>
  t.state === "team" ? (
    <BookCheck className="size-4 text-muted" aria-hidden />
  ) : t.state === "learning" ? (
    <LoaderCircle className="size-4 animate-spin text-accent" aria-hidden />
  ) : t.state === "reverted" ? (
    <Undo2 className="size-4 text-muted" aria-hidden />
  ) : (
    <Lightbulb className="size-4 text-accent" aria-hidden />
  );

/** What a topic holds, in a few words. */
const counts = (t: TopicSummary) =>
  [
    t.learnings ? count(t.learnings, "learning") : null,
    t.corrections ? count(t.corrections, "correction") : null,
    t.memories ? (t.memories === 1 ? "your memory" : `${t.memories} of your memories`) : null,
    t.tests ? count(t.tests, "test") : null,
  ].filter(Boolean);

/**
 * Knowledge → Learnings: one topic per thing the team corrected or defined, what waits for a tap first,
 * each opening its page. An owner or admin sees every topic; anyone else the team's terms and their own.
 */
export default async function LearningsPage() {
  const viewer = await requireTenant();
  const orgId = viewer.ctx.orgId;
  const topics = await withTenant({ orgId, userId: viewer.user.id }, (tx) =>
    listTopics(tx, { orgId, userId: viewer.user.id, approver: canVerify(viewer.role) }),
  );
  return (
    <>
      <TopBar crumbs={[{ label: "Knowledge", href: "/knowledge" }, { label: "Learnings" }]} />
      <div className="flex-1 overflow-y-auto px-8 pt-8 pb-16">
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-1.5">
            <h1 className="text-display">Learnings</h1>
            <p className="max-w-reading text-body text-muted">
              One topic for each thing your team corrected or defined: what it means, how it was learned, your own
              memories about it, the guides and tests on it.
            </p>
          </div>
          {topics.length ? (
            <div className="flex flex-col divide-y divide-border overflow-hidden rounded-2xl border border-border">
              {topics.map((t) => (
                <ListRow
                  key={t.slug}
                  href={`/knowledge/learnings/${t.slug}`}
                  icon={icon(t)}
                  title={t.title}
                  meta={[t.line, ...counts(t)].filter(Boolean).join(" · ")}
                  status={TOPIC_STATE[t.state]}
                />
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2 rounded-2xl border border-border py-16 text-center">
              <Lightbulb className="size-5 text-muted" aria-hidden />
              <p className="text-body">Nothing learned yet.</p>
              <p className="max-w-reading text-small text-muted">
                When someone corrects an answer, it's kept for them at once, and becomes a topic here as it's learned
                for the team.
              </p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

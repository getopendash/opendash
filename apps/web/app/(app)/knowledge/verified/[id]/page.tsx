import { isUuid } from "@opendash/db";
import { StatusBadge } from "@opendash/ui";
import { MessageSquareText, ShieldCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AskBeside } from "@/components/panel/ask-beside";
import { PageFocus } from "@/components/panel/page-focus";
import { TopBar } from "@/components/shell/top-bar";
import { VerifiedActions } from "@/components/verified/verified-actions";
import { SpecRows } from "@/components/verified/verify-dialog";
import { requireTenant } from "@/lib/auth";
import { shortDate } from "@/lib/format";
import { canVerify } from "@/lib/knowledge";
import { verifiedFor } from "@/lib/verified";

export const metadata: Metadata = { title: "Verified query · OpenDash" };

/** A verified query: the question, its other wordings, what it computes, its result when saved, its versions. */
export default async function VerifiedQueryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const viewer = await requireTenant();
  const v = await verifiedFor(viewer.ctx.orgId, viewer.user.id, id);
  if (!v) notFound();
  const name = (userId: string | null) => (userId ? (v.names[userId] ?? "a former member") : "someone");
  const saved = v.versions.at(-1);
  const f = v.spec.fingerprint;
  return (
    <>
      <TopBar
        crumbs={[
          { label: "Knowledge", href: "/knowledge" },
          { label: "Verified queries", href: "/knowledge/verified" },
          { label: v.question },
        ]}
        action={
          <span className="flex items-center gap-1.5">
            <AskBeside text={v.question} connectionId={v.connectionId}>
              <MessageSquareText className="size-3.5" aria-hidden />
              Ask this
            </AskBeside>
            <PageFocus
              focus={{ item: { kind: "verified_query", id: v.id, title: v.question }, connectionId: v.connectionId }}
            />
            {canVerify(viewer.role) ? <VerifiedActions id={v.id} spec={v.spec} titles={v.titles} /> : null}
          </span>
        }
      />
      <div className="flex-1 overflow-y-auto px-6 pt-6 pb-16 @2xl/page:px-8">
        <div className="flex flex-col gap-8 @5xl/page:flex-row">
          <div className="flex min-w-0 flex-1 flex-col gap-6">
            <header className="flex items-start gap-4">
              <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl border border-border bg-surface-secondary">
                <ShieldCheck className="size-5" aria-hidden />
              </span>
              <div className="flex flex-col gap-1">
                <h1 className="flex flex-wrap items-center gap-2 text-display">
                  {v.question}
                  <StatusBadge status="verified" />
                </h1>
                <p className="text-small text-muted">
                  Verified query · version {v.version} · saved {saved ? shortDate(saved.createdAt) : ""} by{" "}
                  {name(saved?.authorId ?? v.verifiedBy)}, from{" "}
                  {v.threadId ? (
                    <Link href={`/ask/${v.threadId}`} className="text-link hover:underline">
                      an answer that passed its checks
                    </Link>
                  ) : (
                    "an answer in a conversation you can't open"
                  )}
                </p>
              </div>
            </header>
            {v.phrasings.length ? (
              <section className="flex flex-col gap-1.5">
                <h2 className="text-small font-medium text-muted">Also asked as</h2>
                <ul className="flex flex-col gap-0.5 text-body">
                  {v.phrasings.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </section>
            ) : null}
            <section className="flex max-w-reading flex-col gap-2">
              <h2 className="text-small font-medium text-muted">What it computes</h2>
              <SpecRows spec={v.spec.query} titles={v.titles} />
              <p className="text-small text-muted-tertiary">
                The analyst recomputes it from the verified definitions for each question, adapting the period; it's
                never replayed as it was.
              </p>
            </section>
            <section className="flex flex-col gap-1.5">
              <h2 className="text-small font-medium text-muted">Its result when saved</h2>
              <p className="text-body">
                {f.rows === null
                  ? "Unknown rows"
                  : `${f.rows.toLocaleString("en-US")} ${f.rows === 1 ? "row" : "rows"}`}
                {f.columns.length ? (
                  <>
                    {" · "}
                    <span className="font-mono text-small">{f.columns.map((c) => c.name).join(", ")}</span>
                  </>
                ) : null}
                <span className="text-muted-tertiary"> · {shortDate(f.savedAt)}</span>
              </p>
            </section>
          </div>
          <aside className="flex flex-col gap-6 @5xl/page:w-inspector">
            <section className="flex flex-col gap-1">
              <h2 className="text-small font-medium text-muted">Answers it guided</h2>
              <p className="text-body">{v.usageCount}</p>
            </section>
            <section className="flex flex-col gap-2">
              <h2 className="text-small font-medium text-muted">Versions {v.versions.length}</h2>
              <ul className="flex flex-col divide-y divide-border">
                {v.versions.map((x) => (
                  <li key={x.version} className="flex gap-3 py-2 text-body">
                    <span className="w-8 font-medium">v{x.version}</span>
                    <span className="flex flex-col">
                      <span>
                        {x.version === 1 ? "Saved" : "Edited"} {shortDate(x.createdAt)} by {name(x.authorId)}
                      </span>
                      {x.changeNote ? <span className="text-small text-muted">{x.changeNote}</span> : null}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          </aside>
        </div>
      </div>
    </>
  );
}

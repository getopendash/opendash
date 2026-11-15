import { Chip } from "@heroui/react";
import type { TermSpec } from "@opendash/core";
import { isUuid } from "@opendash/db";
import { BookA, MessageSquareText } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CommonValues } from "@/components/context/common-values";
import { ContextActions } from "@/components/context/context-actions";
import { ContextStatus, MapsTo } from "@/components/context/context-tables";
import { AskBeside } from "@/components/panel/ask-beside";
import { TopBar } from "@/components/shell/top-bar";
import { requireTenant } from "@/lib/auth";
import { contextItemFor, sourcesFor } from "@/lib/context";
import { shortDate } from "@/lib/format";
import { canVerify } from "@/lib/knowledge";

export const metadata: Metadata = { title: "Term · OpenDash" };

/** A term's page. */
export default async function TermPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const viewer = await requireTenant();
  const t = await contextItemFor(viewer.ctx.orgId, id);
  if (t?.kind !== "term") notFound();
  const spec = t.spec as TermSpec;
  // Its column's values are read live when someone asks: the page only needs the source's name.
  const source =
    spec.maps_to?.column && t.connectionId
      ? ((await sourcesFor(viewer.ctx.orgId)).find((s) => s.id === t.connectionId)?.name ?? "its source")
      : null;
  return (
    <>
      <TopBar
        crumbs={[
          { label: "Knowledge", href: "/knowledge" },
          { label: "Glossary", href: "/knowledge/glossary" },
          { label: t.title },
        ]}
        action={
          <span className="flex items-center gap-1.5">
            <AskBeside connectionId={t.connectionId}>
              <MessageSquareText className="size-3.5" aria-hidden />
              Ask about this
            </AskBeside>
            {canVerify(viewer.role) ? (
              <ContextActions id={t.id} version={t.version} status={t.status} kind="glossary" title={t.title} />
            ) : null}
          </span>
        }
      />
      <div className="flex-1 overflow-y-auto px-6 pt-6 pb-16 @2xl/page:px-8">
        <div className="flex flex-col gap-8 @5xl/page:flex-row">
          <div className="flex min-w-0 flex-1 flex-col gap-6">
            <header className="flex items-start gap-4">
              <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl border border-border bg-surface-secondary">
                <BookA className="size-5" aria-hidden />
              </span>
              <div className="flex flex-col gap-1">
                <h1 className="flex flex-wrap items-center gap-2 text-display">
                  {t.title}
                  <ContextStatus c={t} />
                </h1>
                <p className="text-small text-muted">
                  Term · version {t.version}
                  {t.releasedVersion && t.releasedVersion !== t.version
                    ? ` · the analyst reads version ${t.releasedVersion} until this one is approved`
                    : t.status === "verified"
                      ? " · approved"
                      : " · not approved yet: the analyst doesn't read it"}
                </p>
              </div>
            </header>
            <section className="flex flex-col gap-1.5">
              <h2 className="text-small font-medium text-muted">Means</h2>
              <p className="max-w-reading text-lead">{spec.means}</p>
            </section>
            {spec.maps_to ? (
              <section className="flex flex-col gap-2">
                <h2 className="text-small font-medium text-muted">Maps to</h2>
                <div>
                  <MapsTo m={spec.maps_to} />
                </div>
                {spec.maps_to.column && source ? (
                  <CommonValues
                    termId={t.id}
                    column={spec.maps_to.column}
                    source={source}
                    mapped={spec.maps_to.values ?? []}
                  />
                ) : null}
                {spec.maps_to.note ? <p className="text-small text-muted">{spec.maps_to.note}</p> : null}
              </section>
            ) : null}
            {spec.not?.length ? (
              <section className="flex flex-col gap-2">
                <h2 className="text-small font-medium text-muted">Not the same as</h2>
                <div className="flex flex-wrap gap-1.5">
                  {spec.not.map((table) => (
                    <Chip key={table} size="sm" variant="soft" color="danger">
                      <span className="font-mono">{table}</span>
                    </Chip>
                  ))}
                </div>
                <p className="text-small text-muted-tertiary">The analyst never reads this term from these tables.</p>
              </section>
            ) : null}
            {spec.synonyms.length ? (
              <section className="flex flex-col gap-2">
                <h2 className="text-small font-medium text-muted">Also called</h2>
                <div className="flex flex-wrap gap-1.5">
                  {spec.synonyms.map((s) => (
                    <Chip key={s} size="sm" variant="soft">
                      {s}
                    </Chip>
                  ))}
                </div>
                <p className="text-small text-muted-tertiary">
                  A question that uses any of these words reads this term.
                </p>
              </section>
            ) : null}
          </div>
          <aside className="flex flex-col gap-2 @5xl/page:w-inspector">
            <h2 className="text-small font-medium text-muted">Versions {t.versions.length}</h2>
            <ul className="flex flex-col divide-y divide-border">
              {t.versions.map((v) => (
                <li key={v.version} className="flex gap-3 py-2 text-body">
                  <span className="w-8 font-medium">v{v.version}</span>
                  <span className="flex flex-col">
                    <span>
                      {shortDate(v.createdAt)}
                      {v.version === t.releasedVersion ? (
                        <Chip size="sm" variant="soft" color="success" className="ml-2">
                          Approved
                        </Chip>
                      ) : null}
                    </span>
                    {v.changeNote ? <span className="text-small text-muted">{v.changeNote}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          </aside>
        </div>
      </div>
    </>
  );
}

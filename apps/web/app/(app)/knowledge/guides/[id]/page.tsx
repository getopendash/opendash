import { Chip } from "@heroui/react";
import type { GuideSpec } from "@opendash/core";
import { isUuid } from "@opendash/db";
import { CodeBlock } from "@opendash/ui";
import { NotebookText, Pin } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ContextActions } from "@/components/context/context-actions";
import { ContextStatus } from "@/components/context/context-tables";
import { TopBar } from "@/components/shell/top-bar";
import { requireTenant } from "@/lib/auth";
import { contextItemFor, sourcesFor } from "@/lib/context";
import { shortDate } from "@/lib/format";
import { canVerify } from "@/lib/knowledge";

export const metadata: Metadata = { title: "Guide · OpenDash" };

/** A guide: what it says, where it applies, its versions. */
export default async function GuidePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const viewer = await requireTenant();
  const [g, sources] = await Promise.all([contextItemFor(viewer.ctx.orgId, id), sourcesFor(viewer.ctx.orgId)]);
  if (g?.kind !== "guide") notFound();
  const spec = g.spec as GuideSpec;
  const source = sources.find((s) => s.id === g.connectionId)?.name;
  return (
    <>
      <TopBar
        crumbs={[
          { label: "Knowledge", href: "/knowledge" },
          { label: "Guides", href: "/knowledge/guides" },
          { label: g.title },
        ]}
        action={
          canVerify(viewer.role) ? (
            <ContextActions id={g.id} version={g.version} status={g.status} kind="guides" title={g.title} />
          ) : null
        }
      />
      <div className="flex-1 overflow-y-auto px-6 pt-6 pb-16 @2xl/page:px-8">
        <div className="flex flex-col gap-8 @5xl/page:flex-row">
          <div className="flex min-w-0 flex-1 flex-col gap-6">
            <header className="flex items-start gap-4">
              <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl border border-border bg-surface-secondary">
                <NotebookText className="size-5" aria-hidden />
              </span>
              <div className="flex flex-col gap-1">
                <h1 className="flex flex-wrap items-center gap-2 text-display">
                  {g.title}
                  <ContextStatus c={g} />
                </h1>
                <p className="flex flex-wrap items-center gap-1.5 text-small text-muted">
                  Guide · version {g.version} ·{" "}
                  {spec.table ? (
                    <code className="font-mono">{spec.table}</code>
                  ) : source ? (
                    <span className="font-mono">{source}</span>
                  ) : (
                    "whole workspace"
                  )}
                  {spec.pinned ? (
                    <span className="flex items-center gap-1 text-accent">
                      · <Pin className="size-3" aria-hidden /> pinned
                    </span>
                  ) : null}
                  {g.releasedVersion && g.releasedVersion !== g.version
                    ? ` · the analyst reads version ${g.releasedVersion} until this one is approved`
                    : g.status !== "verified"
                      ? " · not approved yet: the analyst doesn't read it"
                      : ""}
                </p>
              </div>
            </header>
            <CodeBlock code={g.body} label="Markdown" wrap />
          </div>
          <aside className="flex flex-col gap-2 @5xl/page:w-inspector">
            <h2 className="text-small font-medium text-muted">Versions {g.versions.length}</h2>
            <ul className="flex flex-col divide-y divide-border">
              {g.versions.map((v) => (
                <li key={v.version} className="flex gap-3 py-2 text-body">
                  <span className="w-8 font-medium">v{v.version}</span>
                  <span className="flex flex-col">
                    <span>
                      {shortDate(v.createdAt)}
                      {v.version === g.releasedVersion ? (
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

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { TopBar } from "@/components/shell/top-bar";
import { SourceActions } from "@/components/sources/source-actions";
import { SampleDataChip, SourceStatusChip } from "@/components/sources/source-status";
import { SourceTabs } from "@/components/sources/source-tabs";
import { SourceTile } from "@/components/sources/source-tile";
import { requireTenant } from "@/lib/auth";
import { dialectLabel, shortDate } from "@/lib/format";
import { canManageSources, sourcePage } from "@/lib/sources";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const viewer = await requireTenant();
  const data = await sourcePage(viewer.ctx.orgId, viewer.user.id, (await params).id);
  return { title: `${data?.source.name ?? "Source"} · OpenDash` };
}

/**
 * A source's pages: the top bar's actions, then, once it's learned, the header and the tabs. While it's
 * being learned for the first time there's only the learning view, without a header.
 */
export default async function SourceLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const viewer = await requireTenant();
  const data = await sourcePage(viewer.ctx.orgId, viewer.user.id, id);
  if (!data) notFound();
  const { source, run, test } = data;
  const learned = source.learnedAt !== null;
  const canManage = canManageSources(viewer.role);
  return (
    <>
      <TopBar
        crumbs={[
          { label: "Data", href: "/data/sources" },
          { label: "Sources", href: "/data/sources" },
          { label: source.name },
        ]}
        action={
          learned && canManage && source.status !== "disabled" ? (
            <SourceActions
              source={source}
              busy={{
                testing: test !== null && (test.status === "queued" || test.status === "running"),
                syncing: run !== null && (run.status === "queued" || run.status === "running"),
              }}
            />
          ) : undefined
        }
      />
      <div className="flex-1 overflow-y-auto px-8 pt-8 pb-16">
        {learned ? (
          <div className="flex flex-col gap-6">
            <header className="flex items-center gap-4">
              <SourceTile kind={source.dialect} size="lg" />
              <div className="flex min-w-0 flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2.5">
                  <h1 className="truncate text-display">{source.name}</h1>
                  <SourceStatusChip source={source} />
                  {source.sample ? <SampleDataChip /> : null}
                </div>
                <p className="truncate text-body text-muted">
                  {dialectLabel(source.dialect, source.serverVersion)} · {source.host} · connected{" "}
                  {shortDate(source.createdAt)}
                </p>
              </div>
            </header>
            <SourceTabs id={source.id} tables={source.tables} canManage={canManage} />
            {children}
          </div>
        ) : (
          children
        )}
      </div>
    </>
  );
}

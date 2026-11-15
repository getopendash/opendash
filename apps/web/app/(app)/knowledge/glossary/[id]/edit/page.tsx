import { isUuid } from "@opendash/db";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { TermEditor } from "@/components/context/context-editor";
import { TopBar } from "@/components/shell/top-bar";
import { requireTenant } from "@/lib/auth";
import { contextItemFor, sourcesFor } from "@/lib/context";
import { canVerify } from "@/lib/knowledge";

export const metadata: Metadata = { title: "Edit term · OpenDash" };

/** The glossary: editing a term (a new version, approved separately). Admins only. */
export default async function TermEditPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireTenant();
  if (!canVerify(viewer.role)) redirect("/knowledge/glossary");
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const item = await contextItemFor(viewer.ctx.orgId, id);
  if (item?.kind !== "term") notFound();
  const sources = await sourcesFor(viewer.ctx.orgId);
  return (
    <>
      <TopBar
        crumbs={[
          { label: "Knowledge", href: "/knowledge" },
          { label: "Glossary", href: "/knowledge/glossary" },
          { label: item.title, href: `/knowledge/glossary/${item.id}` },
          { label: "Edit" },
        ]}
      />
      <div className="flex-1 overflow-y-auto px-6 pt-6 pb-16 @2xl/page:px-8">
        <div className="flex flex-col gap-6">
          <h1 className="text-display">{item.title}</h1>
          <TermEditor
            id={item.id}
            initial={item.body}
            connectionId={item.connectionId}
            sources={sources}
            released={item.releasedVersion}
          />
        </div>
      </div>
    </>
  );
}

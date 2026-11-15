import { GUIDE_MAX, PINNED_GUIDE_MAX } from "@opendash/core";
import { isUuid } from "@opendash/db";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { GuideEditor } from "@/components/context/context-editor";
import { TopBar } from "@/components/shell/top-bar";
import { requireTenant } from "@/lib/auth";
import { contextItemFor, sourcesFor, tablesFor } from "@/lib/context";
import { canVerify } from "@/lib/knowledge";

export const metadata: Metadata = { title: "Edit guide · OpenDash" };

/** Editing a guide (a new version, approved separately). Admins only. */
export default async function GuideEditPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireTenant();
  if (!canVerify(viewer.role)) redirect("/knowledge/guides");
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const item = await contextItemFor(viewer.ctx.orgId, id);
  if (item?.kind !== "guide") notFound();
  const [sources, tables] = await Promise.all([sourcesFor(viewer.ctx.orgId), tablesFor(viewer.ctx.orgId)]);
  return (
    <>
      <TopBar
        crumbs={[
          { label: "Knowledge", href: "/knowledge" },
          { label: "Guides", href: "/knowledge/guides" },
          { label: item.title, href: `/knowledge/guides/${item.id}` },
          { label: "Edit" },
        ]}
      />
      <div className="flex-1 overflow-y-auto px-6 pt-6 pb-16 @2xl/page:px-8">
        <div className="flex flex-col gap-6">
          <h1 className="text-display">{item.title}</h1>
          <GuideEditor
            id={item.id}
            initial={{
              title: item.title,
              body: item.body,
              pinned: item.pinned,
              connectionId: item.connectionId,
              table: item.table,
            }}
            sources={sources}
            tables={tables}
            released={item.releasedVersion}
            limits={{ pinned: PINNED_GUIDE_MAX, guide: GUIDE_MAX }}
          />
        </div>
      </div>
    </>
  );
}

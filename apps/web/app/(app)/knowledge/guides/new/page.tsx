import { GUIDE_MAX, PINNED_GUIDE_MAX } from "@opendash/core";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { GuideEditor } from "@/components/context/context-editor";
import { TopBar } from "@/components/shell/top-bar";
import { requireTenant } from "@/lib/auth";
import { sourcesFor, tablesFor } from "@/lib/context";
import { canVerify } from "@/lib/knowledge";

export const metadata: Metadata = { title: "New guide · OpenDash" };

/** Writing a new guide. Admins only. */
export default async function GuideNewPage() {
  const viewer = await requireTenant();
  if (!canVerify(viewer.role)) redirect("/knowledge/guides");
  const [sources, tables] = await Promise.all([sourcesFor(viewer.ctx.orgId), tablesFor(viewer.ctx.orgId)]);
  return (
    <>
      <TopBar
        crumbs={[
          { label: "Knowledge", href: "/knowledge" },
          { label: "Guides", href: "/knowledge/guides" },
          { label: "New guide" },
        ]}
      />
      <div className="flex-1 overflow-y-auto px-6 pt-6 pb-16 @2xl/page:px-8">
        <div className="flex flex-col gap-6">
          <h1 className="text-display">{"New guide"}</h1>
          <GuideEditor
            sources={sources}
            tables={tables}
            released={null}
            limits={{ pinned: PINNED_GUIDE_MAX, guide: GUIDE_MAX }}
          />
        </div>
      </div>
    </>
  );
}

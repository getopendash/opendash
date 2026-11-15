import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { TermEditor } from "@/components/context/context-editor";
import { TopBar } from "@/components/shell/top-bar";
import { requireTenant } from "@/lib/auth";
import { sourcesFor } from "@/lib/context";
import { canVerify } from "@/lib/knowledge";

export const metadata: Metadata = { title: "New term · OpenDash" };

/** The glossary: writing a new term. Admins only. */
export default async function TermNewPage() {
  const viewer = await requireTenant();
  if (!canVerify(viewer.role)) redirect("/knowledge/glossary");
  const sources = await sourcesFor(viewer.ctx.orgId);
  return (
    <>
      <TopBar
        crumbs={[
          { label: "Knowledge", href: "/knowledge" },
          { label: "Glossary", href: "/knowledge/glossary" },
          { label: "New term" },
        ]}
      />
      <div className="flex-1 overflow-y-auto px-6 pt-6 pb-16 @2xl/page:px-8">
        <div className="flex flex-col gap-6">
          <h1 className="text-display">{"New term"}</h1>
          <TermEditor sources={sources} released={null} />
        </div>
      </div>
    </>
  );
}

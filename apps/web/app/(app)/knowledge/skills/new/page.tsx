import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SkillEditor } from "@/components/context/skill-editor";
import { TopBar } from "@/components/shell/top-bar";
import { requireTenant } from "@/lib/auth";
import { canVerify } from "@/lib/knowledge";
import { SKILL_LIMIT } from "@/lib/skills";

export const metadata: Metadata = { title: "New skill · OpenDash" };

/** A new skill. Owners and admins only. */
export default async function NewSkillPage() {
  const viewer = await requireTenant();
  if (!canVerify(viewer.role)) redirect("/knowledge/skills");
  return (
    <>
      <TopBar
        crumbs={[
          { label: "Knowledge", href: "/knowledge" },
          { label: "Skills", href: "/knowledge/skills" },
          { label: "New skill" },
        ]}
      />
      <div className="flex-1 overflow-y-auto px-6 pt-6 pb-16 @2xl/page:px-8">
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-1.5">
            <h1 className="text-display">New skill</h1>
            <p className="max-w-reading text-body text-muted">
              A way of working for one kind of question. The analyst follows it once an owner or admin approves it.
            </p>
          </div>
          <SkillEditor released={null} max={SKILL_LIMIT} />
        </div>
      </div>
    </>
  );
}

import type { SkillSpec } from "@opendash/core";
import { isUuid } from "@opendash/db";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { SkillEditor } from "@/components/context/skill-editor";
import { TopBar } from "@/components/shell/top-bar";
import { requireTenant } from "@/lib/auth";
import { canVerify } from "@/lib/knowledge";
import { SKILL_LIMIT, skillFor } from "@/lib/skills";

export const metadata: Metadata = { title: "Edit skill · OpenDash" };

/** Editing a skill (a new version). Owners and admins only. */
export default async function EditSkillPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const viewer = await requireTenant();
  if (!canVerify(viewer.role)) redirect(`/knowledge/skills/${id}`);
  const found = await skillFor(viewer.ctx.orgId, viewer.user.id, id);
  if (!found) notFound();
  const { item } = found;
  const spec = item.spec as SkillSpec;
  return (
    <>
      <TopBar
        crumbs={[
          { label: "Knowledge", href: "/knowledge" },
          { label: "Skills", href: "/knowledge/skills" },
          { label: item.title, href: `/knowledge/skills/${id}` },
          { label: "Edit" },
        ]}
      />
      <div className="flex-1 overflow-y-auto px-6 pt-6 pb-16 @2xl/page:px-8">
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-1.5">
            <h1 className="text-display">Edit {item.title}</h1>
            <p className="max-w-reading text-body text-muted">
              {item.releasedVersion
                ? `Saving makes a draft of version ${item.version + 1}; the analyst follows version ${item.releasedVersion} until it's approved.`
                : "Saving makes a new draft; the analyst follows it once it's approved."}
            </p>
          </div>
          <SkillEditor
            id={id}
            initial={{ title: item.title, useWhen: spec.description, body: item.body }}
            released={item.releasedVersion}
            max={SKILL_LIMIT}
          />
        </div>
      </div>
    </>
  );
}

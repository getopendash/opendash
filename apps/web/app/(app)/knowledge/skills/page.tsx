import { buttonVariants } from "@heroui/react";
import { Plus } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { SkillsTable } from "@/components/context/skills-table";
import { TopBar } from "@/components/shell/top-bar";
import { requireTenant } from "@/lib/auth";
import { canVerify } from "@/lib/knowledge";
import { skillsFor } from "@/lib/skills";

export const metadata: Metadata = { title: "Skills · OpenDash" };

/** The skills. */
export default async function SkillsPage() {
  const viewer = await requireTenant();
  const items = await skillsFor(viewer.ctx.orgId);
  return (
    <>
      <TopBar
        crumbs={[{ label: "Knowledge", href: "/knowledge" }, { label: "Skills" }]}
        action={
          canVerify(viewer.role) ? (
            <Link href="/knowledge/skills/new" className={`${buttonVariants({ size: "sm" })} gap-1`}>
              <Plus className="size-3.5" aria-hidden />
              New skill
            </Link>
          ) : null
        }
      />
      <div className="flex-1 overflow-y-auto px-6 pt-6 pb-16 @2xl/page:px-8">
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-1.5">
            <h1 className="text-display">Skills</h1>
            <p className="max-w-reading text-body text-muted">
              Ways of working the analyst follows for a kind of question, written by your team. It reads one when its
              “use it when” fits, and every answer says which it followed.
            </p>
          </div>
          {items.length ? (
            <SkillsTable items={items} />
          ) : (
            <p className="rounded-2xl border border-dashed border-border px-6 py-12 text-center text-body text-muted">
              No skills yet.{" "}
              {canVerify(viewer.role)
                ? "Write one for a kind of question your team answers the same way every time."
                : "Owners and admins write them."}
            </p>
          )}
        </div>
      </div>
    </>
  );
}

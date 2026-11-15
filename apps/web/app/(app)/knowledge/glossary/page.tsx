import { buttonVariants } from "@heroui/react";
import { Plus } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { ApproveProposed, TermsTable } from "@/components/context/context-tables";
import { TopBar } from "@/components/shell/top-bar";
import { requireTenant } from "@/lib/auth";
import { contextListFor } from "@/lib/context";
import { canVerify } from "@/lib/knowledge";

export const metadata: Metadata = { title: "Glossary · OpenDash" };

/** The glossary. */
export default async function GlossaryPage() {
  const viewer = await requireTenant();
  const items = await contextListFor(viewer.ctx.orgId, "term");
  const admin = canVerify(viewer.role);
  return (
    <>
      <TopBar
        crumbs={[{ label: "Knowledge", href: "/knowledge" }, { label: "Glossary" }]}
        action={
          admin ? (
            <span className="flex items-center gap-1.5">
              <ApproveProposed items={items} />
              <Link href="/knowledge/glossary/new" className={`${buttonVariants({ size: "sm" })} gap-1`}>
                <Plus className="size-3.5" aria-hidden />
                New term
              </Link>
            </span>
          ) : null
        }
      />
      <div className="flex-1 overflow-y-auto px-6 pt-6 pb-16 @2xl/page:px-8">
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-1.5">
            <h1 className="text-display">Glossary</h1>
            <p className="text-body text-muted">
              The words your team uses, and what they mean in your data. The analyst reads every approved term.
            </p>
          </div>
          {items.length ? (
            <TermsTable items={items} />
          ) : (
            <p className="rounded-2xl border border-dashed border-border px-6 py-12 text-center text-body text-muted">
              No terms yet. {admin ? "Add the words your team uses, so every answer reads them the same way." : ""}
            </p>
          )}
        </div>
      </div>
    </>
  );
}

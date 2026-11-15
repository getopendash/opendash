import { buttonVariants } from "@heroui/react";
import { Plus } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { GuidesTable } from "@/components/context/context-tables";
import { TopBar } from "@/components/shell/top-bar";
import { requireTenant } from "@/lib/auth";
import { contextListFor, sourcesFor } from "@/lib/context";
import { canVerify } from "@/lib/knowledge";

export const metadata: Metadata = { title: "Guides · OpenDash" };

/** The guides. */
export default async function GuidesPage() {
  const viewer = await requireTenant();
  const [items, sources] = await Promise.all([contextListFor(viewer.ctx.orgId, "guide"), sourcesFor(viewer.ctx.orgId)]);
  const admin = canVerify(viewer.role);
  const corrections = items.filter((g) => g.fromCorrection && g.status === "proposed").length;
  return (
    <>
      <TopBar
        crumbs={[{ label: "Knowledge", href: "/knowledge" }, { label: "Guides" }]}
        action={
          admin ? (
            <Link href="/knowledge/guides/new" className={`${buttonVariants({ size: "sm" })} gap-1`}>
              <Plus className="size-3.5" aria-hidden />
              New guide
            </Link>
          ) : null
        }
      />
      <div className="flex-1 overflow-y-auto px-6 pt-6 pb-16 @2xl/page:px-8">
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-1.5">
            <h1 className="text-display">Guides</h1>
            <p className="text-body text-muted">
              What your team wants the analyst to know: how you count things, which data to trust. Pinned guides are
              read on every question; the rest when they're relevant.
            </p>
          </div>
          {/* A correction someone gave on an answer, waiting for an admin before every analyst uses it. */}
          {admin && corrections ? (
            <p className="rounded-xl border border-border px-4 py-3 text-body text-muted">
              {corrections === 1
                ? "A correction from an answer is waiting for review."
                : `${corrections} corrections from answers are waiting for review.`}{" "}
              Approve one and every analyst uses it; until then, only the person who gave it.
            </p>
          ) : null}
          {items.length ? (
            <GuidesTable items={items} sources={Object.fromEntries(sources.map((s) => [s.id, s.name]))} />
          ) : (
            <p className="rounded-2xl border border-dashed border-border px-6 py-12 text-center text-body text-muted">
              No guides yet.
            </p>
          )}
        </div>
      </div>
    </>
  );
}

import { MEMORIES_GIVEN, MEMORIES_KEPT } from "@opendash/core";
import type { Metadata } from "next";
import { MemoryTable } from "@/components/memory/memory-table";
import { TopBar } from "@/components/shell/top-bar";
import { requireTenant } from "@/lib/auth";
import { memoriesFor } from "@/lib/memory";

export const metadata: Metadata = { title: "Memory · OpenDash" };

/** What this person asked the analyst to remember. Theirs alone. */
export default async function MemoryPage() {
  const viewer = await requireTenant();
  const items = await memoriesFor(viewer.ctx.orgId, viewer.user.id);
  return (
    <>
      <TopBar crumbs={[{ label: "Knowledge", href: "/knowledge" }, { label: "Memory" }]} />
      <div className="flex-1 overflow-y-auto px-6 pt-6 pb-16 @2xl/page:px-8">
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-1.5">
            <h1 className="text-display">Memory</h1>
            <p className="max-w-reading text-body text-muted">
              What you asked the analyst to remember: how you read a word, what to leave out, how you like numbers. Only
              you see these, and only your own questions use them. They never change a verified definition.
            </p>
          </div>
          {items.length ? (
            <MemoryTable items={items} kept={MEMORIES_KEPT} given={MEMORIES_GIVEN} />
          ) : (
            <p className="rounded-2xl border border-dashed border-border px-6 py-12 text-center text-body text-muted">
              Nothing yet.
            </p>
          )}
          <p className="text-small text-muted-tertiary">
            Ask the analyst to remember something (“remember that by churn I mean churned MRR”), or choose Remember on
            an answer.
          </p>
        </div>
      </div>
    </>
  );
}

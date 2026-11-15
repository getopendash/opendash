import { getAuthDatabase, memberNames } from "@opendash/auth";
import { dashboards } from "@opendash/core";
import { withTenant } from "@opendash/db";
import { LayoutDashboard } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { NewDashboardButton, NoDashboards, StartFromAJob } from "@/components/dashboards/new-dashboard";
import { TopBar } from "@/components/shell/top-bar";
import { requireTenant } from "@/lib/auth";
import { ago } from "@/lib/format";

export const metadata: Metadata = { title: "Dashboards · OpenDash" };
export const dynamic = "force-dynamic";

const SHARED = { private: "Only its owner", project: "Its project", org: "Everyone" } as const;

/**
 * The dashboards someone reads: theirs (one being built included) and those shared with them (by visibility, or with
 * them by name: "Shared with you"), latest first.
 */
export default async function DashboardsPage() {
  const viewer = await requireTenant();
  const who = { orgId: viewer.ctx.orgId, userId: viewer.user.id };
  const [list, planned] = await withTenant(viewer.ctx, async (tx) => [
    await dashboards.listDashboards(tx, who),
    // Plans not built yet wait in the list, as planned: Build it is in their conversation.
    await dashboards.plannedDashboards(tx, who),
  ]);
  const others = [...new Set(list.filter((d) => !d.mine).map((d) => d.ownerId))];
  const names = others.length ? await memberNames(getAuthDatabase(), who.orgId, others) : {};
  const now = Date.now();
  return (
    <>
      <TopBar crumbs={[{ label: "Dashboards" }]} action={<NewDashboardButton />} />
      <div className="flex-1 overflow-y-auto px-8 pt-8 pb-16">
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-1.5">
            <h1 className="text-display">Dashboards</h1>
            <p className="text-body text-muted">
              Each built by the analyst for a purpose. Every number is a query you can open.
            </p>
          </div>
          {list.length || planned.length ? <StartFromAJob /> : null}
          {list.length || planned.length ? (
            <ul className="flex flex-col divide-y divide-border border-y border-border">
              {planned.map((p) => (
                <li key={p.runId}>
                  <Link href={`/ask/${p.threadId}`} className="flex items-center gap-3 px-1 py-2.5 hover:bg-default">
                    <LayoutDashboard className="size-3.5 shrink-0 text-muted-tertiary" aria-hidden />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-body">{p.title}</span>
                      {p.purpose ? <span className="truncate text-small text-muted">{p.purpose}</span> : null}
                    </span>
                    <span className="hidden w-28 truncate text-small text-muted-tertiary @2xl/page:block">Planned</span>
                    <span className="hidden w-32 truncate text-small text-muted @2xl/page:block">You</span>
                    <span className="w-20 text-right text-small text-muted-tertiary">{ago(p.plannedAt, now)}</span>
                  </Link>
                </li>
              ))}
              {list.map((d) => (
                <li key={d.id}>
                  <Link href={`/dashboards/${d.id}`} className="flex items-center gap-3 px-1 py-2.5 hover:bg-default">
                    <LayoutDashboard className="size-3.5 shrink-0 text-muted-tertiary" aria-hidden />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-body">{d.title}</span>
                        {d.building ? (
                          // The analyst is building or changing it now: the person sees it at once, from Build it.
                          <span className="shrink-0 rounded-md bg-accent-soft px-1.5 text-small text-accent-soft-foreground">
                            Building
                          </span>
                        ) : null}
                      </span>
                      {d.purpose ? <span className="truncate text-small text-muted">{d.purpose}</span> : null}
                    </span>
                    <span className="hidden w-28 truncate text-small text-muted-tertiary @2xl/page:block">
                      {d.sharedRole
                        ? d.sharedRole === "edit"
                          ? "Shared, can edit"
                          : "Shared with you"
                        : d.currentVersion
                          ? SHARED[d.visibility]
                          : d.draft
                            ? "Draft"
                            : d.building
                              ? "Being built"
                              : "Not built yet"}
                    </span>

                    <span className="hidden w-32 truncate text-small text-muted @2xl/page:block">
                      {d.mine ? "You" : (names[d.ownerId] ?? "Someone who left")}
                    </span>
                    <span className="w-20 text-right text-small text-muted-tertiary">{ago(d.updatedAt, now)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <NoDashboards />
          )}
        </div>
      </div>
    </>
  );
}

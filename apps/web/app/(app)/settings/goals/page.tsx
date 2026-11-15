import { Target } from "lucide-react";
import type { Metadata } from "next";
import { GoalsTable, NewGoal } from "@/components/goals/goals-table";
import { TopBar } from "@/components/shell/top-bar";
import { SettingsFrame } from "@/components/team/settings-frame";
import { requireTenant } from "@/lib/auth";
import { goalRow } from "@/lib/goal-rows";
import { goalMetricsFor, goalsFor } from "@/lib/goals";
import { canVerify } from "@/lib/knowledge";

export const metadata: Metadata = { title: "Goals · OpenDash" };
export const dynamic = "force-dynamic";

/** The goals, each on a verified metric, with how it stands. Owners and admins set them. */
export default async function GoalsPage() {
  const viewer = await requireTenant();
  const [goals, metrics] = await Promise.all([goalsFor(viewer.ctx.orgId), goalMetricsFor(viewer.ctx.orgId)]);
  const admin = canVerify(viewer.role);
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  const choices = metrics.map(({ id, title, direction }) => ({ id, title, direction }));
  return (
    <>
      <TopBar
        crumbs={[{ label: "Settings", href: "/settings/members" }, { label: "Goals" }]}
        action={admin ? <NewGoal metrics={choices} today={today} /> : null}
      />
      <SettingsFrame>
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-1.5">
            <h1 className="text-display">Goals</h1>
            <p className="max-w-reading text-body text-muted">
              What your team is working towards, each on a verified metric. Home shows how each stands, as of its
              metric's last test. Owners and admins set them.
            </p>
          </div>
          {goals.length ? (
            <GoalsTable goals={goals.map((g) => goalRow(g, now))} metrics={choices} admin={admin} today={today} />
          ) : (
            <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-border px-6 py-12 text-center">
              <Target className="size-5 text-muted" aria-hidden />
              <p className="text-body text-muted">
                {metrics.length
                  ? admin
                    ? "No goals yet. Set one on a verified metric: “MRR to $500k by Dec 31”."
                    : "No goals yet. Owners and admins set them."
                  : "Goals are set on verified metrics: verify one first."}
              </p>
            </div>
          )}
        </div>
      </SettingsFrame>
    </>
  );
}

import { buttonVariants } from "@heroui/react";
import { type HealthAlert, orgHealth } from "@opendash/core";
import { withTenant } from "@opendash/db";
import { ChevronRight, CircleCheck, Hourglass, RotateCw, TriangleAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { TopBar } from "@/components/shell/top-bar";
import { SettingsFrame } from "@/components/team/settings-frame";
import { requireTenant } from "@/lib/auth";
import { ago } from "@/lib/format";
import { canManageTeam } from "@/lib/team";

export const metadata: Metadata = { title: "Health · OpenDash" };
export const dynamic = "force-dynamic";

const times = (n: number) => (n === 1 ? "once" : `seen ${n} times`);

function AlertRow({ a, now }: { a: HealthAlert; now: number }) {
  const stalled = a.kind === "stuck_run" || a.kind === "lost_job";
  const Icon = a.kind === "stuck_run" ? Hourglass : a.kind === "lost_job" ? RotateCw : TriangleAlert;
  return (
    <li className="flex items-start gap-3 px-4 py-3.5">
      <span
        className={`flex size-7 shrink-0 items-center justify-center rounded-lg ${stalled ? "bg-warning-soft text-warning-soft-foreground" : "bg-danger-soft text-danger-soft-foreground"}`}
      >
        <Icon className="size-3.5" aria-hidden />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-body font-medium">{a.title}</span>
        <span className="text-small text-muted">{a.message}</span>
        <span className="text-small text-muted-tertiary">
          {[
            a.context,
            times(a.count),
            a.resolvedAt ? `resolved ${ago(a.resolvedAt, now)}` : `last ${ago(a.lastSeenAt, now)}`,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </span>
      {a.href && a.action && !a.resolvedAt ? (
        <Link href={a.href} className={buttonVariants({ size: "sm", variant: "outline" })}>
          {a.action}
        </Link>
      ) : null}
    </li>
  );
}

/** What needs attention in the workspace, and the questions that failed lately. Owners and admins. */
export default async function HealthPage() {
  const viewer = await requireTenant();
  if (!canManageTeam(viewer.role)) redirect("/settings/members");
  const health = await withTenant(viewer.ctx, (tx) =>
    orgHealth(tx, { orgId: viewer.ctx.orgId, userId: viewer.user.id }),
  );
  const now = Date.now();
  const failed = health.failed.reduce((n, f) => n + f.questions, 0);
  return (
    <>
      <TopBar crumbs={[{ label: "Settings", href: "/settings/members" }, { label: "Health" }]} />
      <SettingsFrame>
        <div className="flex flex-col gap-1.5">
          <h1 className="text-display">Health</h1>
          <p className="text-body text-muted">
            What needs attention in the workspace: questions that stalled, and background work that didn't finish.
            OpenDash checks every minute.
          </p>
        </div>
        <section className="flex flex-col gap-2">
          <h2 className="flex items-center gap-2 text-body font-semibold">
            Needs attention
            <span className="text-small font-normal text-muted-tertiary">{health.open.length}</span>
          </h2>
          {health.open.length ? (
            <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-2xl border border-border">
              {health.open.map((a) => (
                <AlertRow key={a.id} a={a} now={now} />
              ))}
            </ul>
          ) : (
            <p className="flex items-center gap-2 rounded-2xl border border-border px-4 py-3.5 text-body text-muted">
              <CircleCheck className="size-4 text-success" aria-hidden />
              Nothing needs attention.
            </p>
          )}
        </section>
        <section className="flex flex-col gap-2">
          <h2 className="flex items-center gap-2 text-body font-semibold">
            Questions that failed, last 7 days
            <span className="text-small font-normal text-muted-tertiary">{failed}</span>
          </h2>
          {health.failed.length ? (
            <div className="overflow-x-auto rounded-2xl border border-border">
              <table className="w-full text-small">
                <thead className="bg-surface-secondary text-muted-tertiary">
                  <tr>
                    <th className="px-4 py-2 text-start font-medium">Reason</th>
                    <th className="w-24 px-4 py-2 text-end font-medium">Questions</th>
                    <th className="w-28 px-4 py-2 text-end font-medium">Last</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {health.failed.map((f) => (
                    <tr key={f.reason}>
                      <th scope="row" className="px-4 py-2.5 text-start font-normal">
                        {f.reason}
                      </th>
                      <td className="px-4 py-2.5 text-end tabular-nums">{f.questions}</td>
                      <td className="px-4 py-2.5 text-end text-muted">{ago(f.lastAt, now)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-body text-muted">None.</p>
          )}
        </section>
        {health.resolved.length ? (
          <details className="group flex flex-col gap-2">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 text-small font-medium text-muted">
              <ChevronRight className="size-3 transition-transform group-open:rotate-90" aria-hidden />
              Resolved in the last 7 days
              <span className="font-normal text-muted-tertiary">{health.resolved.length}</span>
            </summary>
            <ul className="mt-2 flex flex-col divide-y divide-border overflow-hidden rounded-2xl border border-border">
              {health.resolved.map((a) => (
                <AlertRow key={a.id} a={a} now={now} />
              ))}
            </ul>
          </details>
        ) : null}
        <p className="max-w-reading text-small text-muted-tertiary">
          Alerts about the whole deployment (its database and queues) go to whoever runs it, not here. A stalled
          question is never stopped by this check: the job queue retries or fails it.
        </p>
      </SettingsFrame>
    </>
  );
}

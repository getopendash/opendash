import { auditActors, auditLine, countAudit, listAudit } from "@opendash/core";
import { withTenant } from "@opendash/db";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AuditChainPanel } from "@/components/audit/chain-panel";
import { AuditFilters } from "@/components/audit/filters";
import { TopBar } from "@/components/shell/top-bar";
import { SettingsFrame } from "@/components/team/settings-frame";
import { licensingShown } from "@/enterprise";
import { auditAccess, auditQuery, sinceDays, tenantRun } from "@/lib/audit-log";
import { requireTenant } from "@/lib/auth";
import { count, shortDateTime } from "@/lib/format";
import { canManageTeam } from "@/lib/team";

export const metadata: Metadata = { title: "Audit log · OpenDash" };
export const dynamic = "force-dynamic";

const ACTOR: Record<string, string> = {
  api_key: "An API key",
  scim: "Directory sync",
  slack: "Slack",
  system: "OpenDash",
};

/**
 * Settings → Audit log: who changed what that matters for security, newest first. Owners and admins. Every instance
 * keeps 90 days; with a license that covers it, the chain's state, Verify and exports too.
 */
export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const viewer = await requireTenant();
  if (!canManageTeam(viewer.role)) redirect("/settings/members");
  const access = auditAccess();
  const q = auditQuery(await searchParams, access.ranges);
  const since = sinceDays(q.days);
  const { page, actors, total } = await withTenant(viewer.ctx, async (tx) => ({
    page: await listAudit(tx, { since, actorId: q.who, category: q.what, before: q.before }),
    actors: await auditActors(tx, since),
    total: await countAudit(tx, since, { actorId: q.who, category: q.what }),
  }));
  const chain = access.chain
    ? await access.chain.status(tenantRun(viewer.ctx.orgId, viewer.user.id), viewer.ctx.orgId)
    : null;
  const older = page.older
    ? `?${new URLSearchParams({
        ...(q.who ? { who: q.who } : {}),
        ...(q.what ? { what: q.what } : {}),
        days: String(q.days),
        before: page.older,
      })}`
    : null;

  return (
    <>
      <TopBar crumbs={[{ label: "Settings", href: "/settings/members" }, { label: "Audit log" }]} />
      <SettingsFrame>
        <div className="flex flex-col gap-1.5">
          <h1 className="text-display">Audit log</h1>
          <p className="max-w-reading text-body text-muted">
            Who changed what that matters for security: sign-ins, members and roles, keys, sources, sharing and every
            identity setting. It records which fields changed, never their values.
          </p>
        </div>
        {chain ? (
          <AuditChainPanel status={chain} days={q.days} badge={licensingShown()} />
        ) : (
          <section className="flex flex-col gap-1 rounded-2xl border border-border px-5 py-4">
            <h2 className="text-body font-medium">Kept for 90 days on this instance</h2>
            <p className="text-body text-muted">
              With an Enterprise license: a tamper-evident chain, retention up to seven years, and exports for auditors.
            </p>
          </section>
        )}
        <AuditFilters who={q.who} what={q.what} days={q.days} actors={actors} ranges={access.ranges} />
        {page.rows.length ? (
          <div className="flex flex-col gap-2">
            <div className="overflow-x-auto rounded-2xl border border-border">
              <table className="w-full text-small">
                <thead className="bg-surface-secondary text-muted-tertiary">
                  <tr>
                    <th className="px-4 py-2 text-start font-medium">When</th>
                    <th className="px-4 py-2 text-start font-medium">Who</th>
                    <th className="px-4 py-2 text-start font-medium">What</th>
                    <th className="px-4 py-2 text-start font-medium">On</th>
                    <th className="px-4 py-2 text-start font-medium">From</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {page.rows.map((r) => {
                    const line = auditLine(r.action, r.detail);
                    const note = [line.note, r.fields.length ? `fields: ${r.fields.join(", ")}` : null]
                      .filter(Boolean)
                      .join(" · ");
                    return (
                      <tr key={r.id} className="align-top">
                        <td className="whitespace-nowrap px-4 py-2.5 text-muted-tertiary tabular-nums">
                          {shortDateTime(r.createdAt.toISOString())}
                        </td>
                        <td className="px-4 py-2.5 text-body">{r.actorName ?? ACTOR[r.actorType] ?? "Someone"}</td>
                        <td className="px-4 py-2.5">
                          <span className="block text-body font-medium">{line.label}</span>
                          {note ? <span className="block text-muted-tertiary">{note}</span> : null}
                        </td>
                        <td className="px-4 py-2.5 text-body text-muted">{r.targetName ?? "—"}</td>
                        <td className="whitespace-nowrap px-4 py-2.5 font-mono text-muted-tertiary">{r.ip ?? "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between gap-3 text-small text-muted-tertiary">
              <span className="tabular-nums">
                {count(total, "event")} in the last {q.days} days
              </span>
              {older ? (
                <Link href={older} className="text-link">
                  Older
                </Link>
              ) : null}
            </div>
          </div>
        ) : (
          <p className="text-body text-muted">Nothing matches these filters in the last {q.days} days.</p>
        )}
      </SettingsFrame>
    </>
  );
}

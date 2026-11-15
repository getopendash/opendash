import { BUDGETS, LIMIT_RANGES, parseScheduleRule } from "@opendash/core";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";
import { QueryLimitsForm } from "@/components/sources/query-limits-form";
import { RenameSourceForm, SourceDangerZone } from "@/components/sources/source-danger-zone";
import { SourceSettingsForm } from "@/components/sources/source-settings-form";
import { SyncScheduleForm } from "@/components/sources/sync-schedule-form";
import { requireTenant } from "@/lib/auth";
import { canManageSources, sourcePage } from "@/lib/sources";

function Section({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id={id} className="text-heading">
          {title}
        </h2>
        <p className="text-body text-muted">{description}</p>
      </div>
      {children}
    </section>
  );
}

/**
 * Settings, for owners and admins: the name, how OpenDash connects (tested before it's saved), the sync
 * schedule, the query limits, and the danger zone. Network (SSH tunnels) comes with its own task.
 */
export default async function SourceSettings({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const viewer = await requireTenant();
  const data = await sourcePage(viewer.ctx.orgId, viewer.user.id, id);
  if (!data) notFound();
  if (!canManageSources(viewer.role) || !data.source.learnedAt) redirect(`/data/sources/${id}`);
  const { source } = data;
  return (
    <div className="flex max-w-wizard flex-col gap-10">
      <Section id="name-title" title="Name" description="How this source is called across OpenDash.">
        <RenameSourceForm id={source.id} name={source.name} />
      </Section>
      <Section
        id="connection-title"
        title="Connection"
        description="Changing the host, user or password runs a new connection check before anything is saved."
      >
        <SourceSettingsForm source={source} mode="settings" queuedWarningMs={BUDGETS.connectionTest.queuedWarningMs} />
      </Section>
      <Section
        id="limits-title"
        title="Query limits"
        description="Protects your database. Everything that queries this source, the analyst included, shares these limits."
      >
        <QueryLimitsForm id={source.id} limits={source.limits} ranges={LIMIT_RANGES} />
      </Section>
      <Section
        id="sync-title"
        title="Sync"
        description="OpenDash learns the source again on this schedule, and notices tables and columns that changed."
      >
        <SyncScheduleForm id={source.id} schedule={parseScheduleRule(source.syncRule)} />
      </Section>
      <Section id="danger-title" title="Danger zone" description="These change what OpenDash can do with this source.">
        <SourceDangerZone
          source={{ id: source.id, name: source.name, sample: source.sample, disabled: source.status === "disabled" }}
        />
      </Section>
    </div>
  );
}

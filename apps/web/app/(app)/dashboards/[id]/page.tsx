import { provenanceOf } from "@opendash/apps/dashboard";
import { getAuthDatabase, memberNames } from "@opendash/auth";
import { dashboards } from "@opendash/core";
import { isUuid, withTenant } from "@opendash/db";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BuildBar } from "@/components/dashboards/build-bar";
import { BuildingFrame } from "@/components/dashboards/building-frame";
import { DashboardActions } from "@/components/dashboards/dashboard-actions";
import { DashboardHost } from "@/components/dashboards/dashboard-host";
import { DraftBar } from "@/components/dashboards/draft-bar";
import { PlanOutline } from "@/components/dashboards/plan-card";
import { RenderCheck } from "@/components/dashboards/render-check";
import { PageFocus } from "@/components/panel/page-focus";
import { TopBar } from "@/components/shell/top-bar";
import { requireTenant } from "@/lib/auth";
import { frameUrl } from "@/lib/frames";
import { canManageTeam } from "@/lib/team";

export const metadata: Metadata = { title: "Dashboard · OpenDash" };
export const dynamic = "force-dynamic";

/**
 * An App: its saved version drawn in a sealed frame, or for those who change it (its owner, someone it's
 * shared with to edit), its draft (when there's no version yet, or with ?draft=1). The filters and the record shown
 * live in the address.
 */
/** The queries of a definition that read unverified data, by what they read: said before it's published. */
function unverifiedOf(
  definition: Parameters<typeof provenanceOf>[0],
  provenance: Record<string, "verified" | "unverified" | "table" | "service">,
): { title: string; reads: "unverified" | "table" | "service" }[] {
  return Object.keys(definition.queries).flatMap((qid) => {
    const p = provenance[qid];
    // The query's name in words, as its summaries name it.
    const title = qid.replace(/^q_/, "").replace(/_/g, " ");
    return p && p !== "verified" ? [{ title, reads: p }] : [];
  });
}

export default async function DashboardPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ draft?: string }>;
}) {
  const [{ id }, sp, viewer] = await Promise.all([params, searchParams, requireTenant()]);
  if (!isUuid(id)) notFound();
  const who = { orgId: viewer.ctx.orgId, userId: viewer.user.id };
  const d = await withTenant(viewer.ctx, (tx) => dashboards.getDashboard(tx, who, id));
  if (!d) notFound();
  // Who saved the draft last, when it isn't this viewer: its code is theirs, so its actions are off here (core refuses
  // them) until the viewer saves it or its owner publishes it. Named on the draft bar.
  const otherSaver = d.draft && d.draft.savedBy !== who.userId ? d.draft.savedBy : null;
  const names = await memberNames(
    getAuthDatabase(),
    who.orgId,
    [d.mine ? null : d.ownerId, otherSaver].filter((x): x is string => Boolean(x)),
  );
  const owner = d.mine ? null : (names[d.ownerId] ?? null);
  const savedBy = otherSaver ? (names[otherSaver] ?? "Someone who left") : null;
  const showDraft = Boolean(d.draft?.revision) && (sp.draft === "1" || !d.version);
  const shown =
    showDraft && d.draft?.revision
      ? { revision: d.draft.revision, definition: d.draft.definition, bundleHash: d.draft.bundleHash }
      : d.version
        ? { revision: d.version.revision, definition: d.version.definition, bundleHash: d.version.bundleHash }
        : null;
  // A frame only for what has a page: a draft saved before its /App.tsx (a step of a build) has no bundle, and its
  // frame would wait for an App that never registers. It says so instead.
  const link = shown?.bundleHash ? frameUrl({ bundleHash: shown.bundleHash, title: d.title }) : null;
  // What each query of the draft reads, said again at Publish (its owner's press): a draft's, as the catalog is now.
  const draftDefinition = d.mine && d.draft?.revision ? d.draft.definition : null;
  const unverifiedReads = draftDefinition
    ? unverifiedOf(
        draftDefinition,
        provenanceOf(
          draftDefinition,
          await withTenant(viewer.ctx, (tx) => dashboards.catalogsFor(tx, who.orgId, draftDefinition)),
        ),
      )
    : [];
  // Where each query of what's shown reads, for the quiet line under each chart and grid: a published version as it
  // read things when published (its pins), a draft as the catalog is now.
  const reads = shown
    ? await withTenant(viewer.ctx, async (tx) =>
        dashboards.queryReads(
          tx,
          who.orgId,
          shown.definition,
          await dashboards.catalogsFor(tx, who.orgId, shown.definition, showDraft ? {} : (d.version?.pins ?? {})),
        ),
      )
    : {};
  // The render check (apps as code): the draft its owner or an editor sees is measured at three widths for the
  // analyst.
  const appDraft = d.canEdit && showDraft && Boolean(d.draft?.revision);
  // A width measured before its answers came in isn't done: it's measured again.
  const measured = appDraft
    ? Object.entries((await withTenant(viewer.ctx, (tx) => dashboards.renderCheckOf(tx, who, d.id)))?.widths ?? {})
        .filter(([, w]) => !w.unsettled)
        .map(([width]) => Number(width))
    : [];
  const page = {
    ...d,
    owner,
    frameUrl: d.version ? frameUrl({ bundleHash: d.version.bundleHash, title: d.title }) : null,
    draftFrameUrl: d.draft?.revision ? frameUrl({ bundleHash: d.draft.bundleHash, title: d.title }) : null,
  };
  // The analyst beside it is about it: asking there attaches it, so a question about it, or a change to it (its
  // owner's), is asked from here. A new conversation starts on the source it reads.
  const focusSource =
    Object.values((shown?.definition ?? d.version?.definition ?? d.draft?.definition)?.queries ?? {})[0]?.source
      .connection ?? null;
  return (
    <>
      <PageFocus focus={{ item: { kind: "dashboard", id: d.id, title: d.title }, connectionId: focusSource }} />
      <TopBar
        crumbs={[{ label: "Dashboards", href: "/dashboards" }, { label: d.title }]}
        action={
          <span className="flex items-center gap-3">
            {d.canEdit && d.building ? (
              <BuildBar
                key={d.building.runId}
                dashboardId={d.id}
                runId={d.building.runId}
                startedAt={d.building.startedAt}
                shownRevision={showDraft ? (d.draft?.revision ?? null) : null}
              />
            ) : null}
            {/* Select to edit: whoever changes it (its owner, an editor) picks a piece of the App drawn here. */}
            <DashboardActions
              dashboard={page}
              canManage={canManageTeam(viewer.role)}
              selectable={d.canEdit && Boolean(shown && link)}
            />
          </span>
        }
      />
      {d.canEdit && d.draft?.revision ? (
        <DraftBar
          dashboardId={d.id}
          revision={d.draft.revision}
          showing={showDraft}
          hasVersion={Boolean(d.version)}
          unverified={unverifiedReads}
          // An editor changes the draft; its owner publishes it.
          canPublish={d.mine}
          editors={d.editors}
          savedBy={savedBy}
        />
      ) : null}
      {/* While the agent works on it, the App says so: a light round its edge and what it's doing now. */}
      {(() => {
        const area =
          shown && link ? (
            <DashboardHost
              key={shown.revision}
              dashboard={page}
              draw={{ revision: shown.revision, definition: shown.definition, links: d.mine, reads }}
              frameUrl={link}
            />
          ) : !shown && d.plan ? (
            <PlanOutline plan={d.plan as Parameters<typeof PlanOutline>[0]["plan"]} building={Boolean(d.building)} />
          ) : (
            <div className="flex flex-1 items-center justify-center p-8 text-center text-body text-muted">
              {!shown
                ? "It's being built: nothing is saved yet."
                : !shown.bundleHash
                  ? "This App has no page yet."
                  : "Dashboards can't open here: set OPENDASH_FRAMES_URL to an origin of their own."}
            </div>
          );
        return d.canEdit && d.building ? <BuildingFrame runId={d.building.runId}>{area}</BuildingFrame> : area;
      })()}
      {/* Measured only by whoever saved the draft: it runs their code (core saveRenderCheck says why). */}
      {shown && link && appDraft && !otherSaver ? (
        <RenderCheck
          key={`check:${shown.revision}`}
          dashboard={page}
          draw={{ revision: shown.revision, definition: shown.definition, reads }}
          frameUrl={link}
          measured={measured}
        />
      ) : null}
    </>
  );
}

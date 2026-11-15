import { Alert, buttonVariants } from "@heroui/react";
import {
  BUDGETS,
  DRAFT_TABLES_MAX,
  DRAFT_TABLES_SUGGESTED,
  draftCandidates,
  draftCost,
  learningChoice,
  listSyncRuns,
  parseScheduleRule,
  sourceDraftState,
  sourceReadiness,
} from "@opendash/core";
import { withTenant } from "@opendash/db";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DefinitionsPanel } from "@/components/sources/definitions-panel";
import { HealthPanel } from "@/components/sources/health-panel";
import { LearningChoiceScreen } from "@/components/sources/learning-choice";
import { LearningProgress } from "@/components/sources/learning-progress";
import { ReadinessPanel } from "@/components/sources/readiness-panel";
import { SyncsTable } from "@/components/sources/syncs-table";
import { requireTenant } from "@/lib/auth";
import { ago, count, dataTime, scheduleLabel, shortDate } from "@/lib/format";
import { canManageSources, sourcePage } from "@/lib/sources";

/** A label and its value, one per row, with a hairline (KV Row). */
function Fact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex gap-4 border-b border-border py-2.5 text-body">
      <dt className="w-24 shrink-0 text-muted">{label}</dt>
      <dd className={`min-w-0 break-words ${mono ? "font-mono" : ""}`}>{value}</dd>
    </div>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="flex flex-col gap-1 px-4 py-3">
      <span className="text-small text-muted">{label}</span>
      <span className="text-number-lg tabular-nums">{value}</span>
      {note ? <span className="text-small text-muted-tertiary">{note}</span> : null}
    </div>
  );
}

/**
 * A source: while it's being learned for the first time, the learning steps; once learned, the Overview: health
 * (the latest check and sync), what OpenDash learned, its definitions (with Draft definitions for admins), how ready
 * it is (admins), recent syncs, and the connection's settings.
 * Settings and Used by come with their own tasks; the Catalog is its own tab.
 */
export default async function SourceOverview({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const viewer = await requireTenant();
  const data = await sourcePage(viewer.ctx.orgId, viewer.user.id, id);
  if (!data) notFound();
  const { source, run, test } = data;
  const canManage = canManageSources(viewer.role);
  const { runs, readiness, drafts, picker, choice } = await withTenant(viewer.ctx, async (tx) => ({
    runs: await listSyncRuns(tx, viewer.ctx.orgId, source.id, 5),
    // What OpenDash learns of it, chosen by owners and admins.
    choice: canManage && source.learnedAt ? await learningChoice(tx, viewer.ctx.orgId, source.id) : null,
    // Only owners and admins see how ready a source is.
    readiness: canManage && source.learnedAt ? await sourceReadiness(tx, viewer.ctx.orgId, source.id) : null,
    // Its definitions; owners and admins can draft them from its tables.
    drafts: source.learnedAt ? await sourceDraftState(tx, viewer.ctx.orgId, source.id) : null,
    picker:
      canManage && source.learnedAt
        ? {
            candidates: await draftCandidates(tx, viewer.ctx.orgId, source.id),
            suggested: DRAFT_TABLES_SUGGESTED,
            max: DRAFT_TABLES_MAX,
            cost: await draftCost(tx, viewer.ctx.orgId),
          }
        : null,
  }));
  const now = Date.now();
  const learned = source.learnedAt !== null;
  // Why OpenDash can't see the team's queries, from the latest finished sync, for those who can turn it on.
  const history = runs.find((r) => r.status === "succeeded")?.steps.find((s) => s.key === "history");
  const noHistory = canManage && history?.status === "skipped" ? (history.detail ?? null) : null;
  const active = run && (run.status === "queued" || run.status === "running");
  const progress = run ? (
    <LearningProgress
      key={run.id}
      sourceId={source.id}
      name={source.name}
      initial={run}
      firstTime={!learned}
      canRetry={canManage}
      queuedWarningMs={BUDGETS.connectionTest.queuedWarningMs}
    />
  ) : null;

  if (!learned) {
    // The first learning run, centred, nothing else to show yet.
    return (
      <div className="mx-auto flex max-w-wizard flex-col gap-6 pt-8">
        {progress ?? <p className="text-body text-muted">OpenDash hasn't started learning this source.</p>}
      </div>
    );
  }

  // A source no one has chosen for yet, its schema read: what to learn comes first.
  if (choice && !choice.chosen && !active) {
    return (
      <LearningChoiceScreen
        connectionId={source.id}
        sourceName={source.name}
        choice={choice}
        done={`/data/sources/${source.id}`}
      />
    );
  }
  const learnedTables = choice?.tables.filter((t) => t.learned).length;

  return (
    <div className="flex flex-col gap-8">
      {source.status === "error" ? (
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>OpenDash can't connect to {source.name}</Alert.Title>
            <Alert.Description>
              {source.statusDetail ?? "Its last check failed."} Nothing is queried until a check passes.
            </Alert.Description>
          </Alert.Content>
          {canManage ? (
            <Link
              href={`/data/sources/${source.id}/reconnect`}
              className={buttonVariants({ size: "sm", variant: "secondary" })}
            >
              Reconnect
            </Link>
          ) : null}
        </Alert>
      ) : null}
      {source.status === "failing" ? (
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{source.name}'s queries can't connect</Alert.Title>
            <Alert.Description>
              {source.statusDetail ?? "Its latest query couldn't connect."} Questions, dashboards and Apps on it fail
              until it's fixed. Reconnect it with the right details, or test it again once the server is back.
            </Alert.Description>
          </Alert.Content>
          {canManage ? (
            <Link
              href={`/data/sources/${source.id}/reconnect`}
              className={buttonVariants({ size: "sm", variant: "secondary" })}
            >
              Reconnect
            </Link>
          ) : null}
        </Alert>
      ) : null}
      {source.status === "disabled" ? (
        <Alert status="default">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{source.name} is disabled</Alert.Title>
            <Alert.Description>
              OpenDash doesn't query, check or sync it.{canManage ? " Enable it in Settings." : ""}
            </Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
      {/* A re-sync under way, or one that failed: its steps, above what was learned before. */}
      {active || run?.status === "failed" ? <div className="max-w-wizard">{progress}</div> : null}

      <div className="flex flex-col gap-10 @5xl/page:flex-row">
        <div className="flex min-w-0 flex-1 flex-col gap-8">
          <HealthPanel key={test?.id ?? "none"} initial={test} source={source} now={now} />

          <section aria-labelledby="catalog-title" className="flex flex-col gap-3">
            <div className="flex items-baseline justify-between gap-4">
              <h2 id="catalog-title" className="text-body font-medium">
                Catalog
              </h2>
              <span className="flex items-baseline gap-3 text-small text-muted-tertiary">
                <span>
                  Learned {ago(source.learnedAt as string, now)}
                  {source.dataTo ? ` · data to ${dataTime(source.dataTo, now)}` : ""}
                </span>
                {choice && !choice.sample ? (
                  <Link href={`/data/sources/${source.id}/learning`} className="text-link hover:underline">
                    What OpenDash learns
                  </Link>
                ) : null}
                <Link href={`/data/sources/${source.id}/catalog`} className="text-link hover:underline">
                  Browse catalog
                </Link>
              </span>
            </div>
            {/* Four across once each figure has room (its column, not the page: a side pane can sit beside it). */}
            <div className="@container">
              <div className="grid grid-cols-2 divide-border rounded-2xl border border-border @2xl:grid-cols-4 @2xl:divide-x">
                <Stat
                  label="Tables"
                  value={(source.tables ?? 0).toLocaleString("en-US")}
                  {...(learnedTables !== undefined && choice && !choice.sample
                    ? { note: `${learnedTables.toLocaleString("en-US")} learned, the rest known` }
                    : {})}
                />
                <Stat label="Columns" value={(source.columns ?? 0).toLocaleString("en-US")} />
                <Stat
                  label="Personal data"
                  value={count(source.personalData ?? 0, "column")}
                  note="kept out of samples and the model"
                />
                {/* No copy of the source's values; they're read from it when a question needs one. */}
                <Stat label="Values" value="Read live" note="none kept in OpenDash" />
              </div>
            </div>
            {noHistory ? (
              <Alert status="accent">
                <Alert.Indicator />
                <Alert.Content>
                  <Alert.Title>OpenDash can't see how your team queries {source.name}</Alert.Title>
                  <Alert.Description>
                    {noHistory} Until then, tables rank by what joins them, then by size. Only admins see this.
                  </Alert.Description>
                </Alert.Content>
              </Alert>
            ) : null}
          </section>

          {drafts ? <DefinitionsPanel sourceId={source.id} state={drafts} picker={picker} now={now} /> : null}

          {readiness ? <ReadinessPanel sourceId={source.id} name={source.name} readiness={readiness} /> : null}

          {runs.length ? (
            <section aria-labelledby="syncs-title" className="flex flex-col gap-2">
              <h2 id="syncs-title" className="text-body font-medium">
                Recent syncs
              </h2>
              <SyncsTable runs={runs} now={now} />
            </section>
          ) : null}
        </div>

        <aside
          aria-labelledby="connection-title"
          className="flex w-full flex-col gap-2 @5xl/page:w-80 @5xl/page:shrink-0"
        >
          <h2 id="connection-title" className="text-body font-medium">
            Connection
          </h2>
          <dl className="flex flex-col">
            <Fact label="Host" value={source.port ? `${source.host}:${source.port}` : source.host} mono />
            <Fact label="Database" value={source.database} mono />
            <Fact label="User" value={source.user} mono />
            {source.sslMode ? <Fact label="SSL" value={source.sslMode} /> : null}
            <Fact label="Network" value="Direct" />
            <Fact
              label="Limits"
              value={`${source.limits.parallel} parallel · ${source.limits.statementMs / 1000} s · ${source.limits.maxRows.toLocaleString("en-US")} rows`}
            />
            <Fact
              label="Sync"
              value={`${scheduleLabel(parseScheduleRule(source.syncRule))}${
                source.nextSyncAt ? ` · next ${dataTime(source.nextSyncAt, now)}` : ""
              }`}
            />
            <Fact label="Connected" value={shortDate(source.createdAt)} />
          </dl>
        </aside>
      </div>
    </div>
  );
}

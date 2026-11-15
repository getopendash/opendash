/**
 * What a drafting run reads of the source's definitions (the Modeler's, and a drafter's): those it mustn't
 * repeat, and the drafts a proposal holds now.
 */
import type { ClaimedRun } from "@opendash/core";
import { sql } from "@opendash/db";
import type { AgentDeps } from "../../harness/deps";
import { inert } from "../../instructions/context";

/** The source's datasets and metrics, approved or proposed, one line each, for the Modeler to reuse and not repeat. */
export async function existingDefinitions(deps: AgentDeps, run: ClaimedRun): Promise<string> {
  const rows = await deps.withTenant(run.orgId, (tx) =>
    tx.execute<{
      kind: string;
      slug: string;
      title: string;
      status: string;
      dataset: string | null;
      tables: string[] | null;
    }>(sql`
      select i.kind, i.slug, i.title, i.status, v.spec->>'dataset' as dataset,
        (select array_agg(t) from jsonb_array_elements_text(coalesce(v.derived->'tables', '[]'::jsonb)) t) as tables
      from app.context_item i
      join app.context_item_version v on v.org_id = i.org_id and v.item_id = i.id and v.version = i.current_version
      where i.org_id = ${run.orgId} and i.connection_id = ${run.connectionId} and i.deleted_at is null
        and i.kind in ('dataset', 'metric') and i.status <> 'deprecated'
      order by i.kind, i.slug`),
  );
  return rows
    .map((r) =>
      r.kind === "dataset"
        ? `- dataset ${r.slug} (${inert(r.title)}, ${r.status})${r.tables?.length ? `: reads ${r.tables.join(", ")}` : ""}`
        : `- metric ${r.slug} (${inert(r.title)}, ${r.status}) on ${r.dataset}`,
    )
    .join("\n");
}

/** The drafts a Modeler run's proposal holds now, for its outcome (or a drafter's: its lead's proposal). */
export async function keptDrafts(deps: AgentDeps, run: { orgId: string; id: string }) {
  return deps.withTenant(run.orgId, (tx) =>
    tx.execute<{ kind: "dataset" | "metric"; slug: string; title: string }>(sql`
      select i.kind, i.slug, i.title from app.proposal p
      join app.context_item i on i.org_id = p.org_id and i.id = any(p.items) and i.deleted_at is null
      where p.org_id = ${run.orgId} and p.run_id = ${run.id}
      order by i.kind, i.slug`),
  );
}

/** The drafts a drafter wrote that its lead's proposal still holds: read from the versions it wrote. */
export async function authoredDrafts(deps: AgentDeps, run: { orgId: string; id: string; parentRunId: string }) {
  return deps.withTenant(run.orgId, (tx) =>
    tx.execute<{ kind: "dataset" | "metric"; slug: string; title: string }>(sql`
      select i.kind, i.slug, i.title from app.proposal p
      join app.context_item i on i.org_id = p.org_id and i.id = any(p.items) and i.deleted_at is null
      where p.org_id = ${run.orgId} and p.run_id = ${run.parentRunId}
        and exists (select 1 from app.context_item_version v
          where v.org_id = i.org_id and v.item_id = i.id and v.author_run_id = ${run.id})
      order by i.kind, i.slug`),
  );
}

/**
 * What a batch leaves out: what the lead named, and what each of its drafters left out, read from their
 * runs, so none of it depends on what the lead was told. Once per table or definition named, the lead's first.
 */
export async function batchLeftOut(
  deps: AgentDeps,
  run: { orgId: string; id: string },
  named: { name: string; reason: string }[],
) {
  const rows = await deps.withTenant(run.orgId, (tx) =>
    tx.execute<{ left: { name: string; reason: string }[] | null }>(sql`
      select outcome->'leftOut' as left from app.run
      where org_id = ${run.orgId} and parent_run_id = ${run.id} and jsonb_typeof(outcome->'leftOut') = 'array'
      order by queued_at`),
  );
  const seen = new Set<string>();
  return [...named, ...rows.flatMap((r) => r.left ?? [])]
    .filter((l) => typeof l?.name === "string" && !seen.has(l.name.toLowerCase()) && seen.add(l.name.toLowerCase()))
    .slice(0, 20);
}

import { Chip } from "@heroui/react";
import type { DefinitionDetail, DefinitionKind, LoadedModel } from "@opendash/core";
import { GitBranch, Sigma, Table2 } from "lucide-react";
import { TopBar } from "@/components/shell/top-bar";
import { DefinitionEditor } from "./definition-editor";
import { DefinitionStatusChip } from "./definition-status";

const PLURAL = { metric: "metrics", dataset: "datasets" } as const;
const LABEL = { metric: "Metrics", dataset: "Datasets" } as const;

/** A starting point for a new definition: a metric on the source's first dataset, or a dataset shape. */
export function templateFor(kind: DefinitionKind, model: LoadedModel | null): string {
  if (kind === "metric") {
    const dataset = model ? [...model.model.datasets.values()].find((d) => d.measures.length) : undefined;
    return [
      "name: new_metric",
      "label: New metric",
      "description: What it measures, in a sentence someone outside the data team understands.",
      `dataset: ${dataset?.ref ?? "a_dataset"}`,
      `measure: ${dataset?.measures[0]?.name ?? "a_measure"}`,
      "default_grain: month",
      "direction: higher_is_better",
      "synonyms: []",
      "",
    ].join("\n");
  }
  return [
    "ref: new_dataset",
    "label: New dataset",
    "description: What one row is about, and what it's for.",
    "grain: one row per …",
    "primary_key: [id]",
    "time_column: created_at",
    "sql: |",
    "  select id, created_at",
    "  from public.your_table",
    "columns:",
    "  - { name: id, type: number }",
    "  - { name: created_at, type: time }",
    "measures:",
    '  - { name: rows, expr: "count(*)" }',
    "",
  ].join("\n");
}

/** Editing a definition (a new version) or writing a new one. */
export function DefinitionEditPage({
  kind,
  d,
  connectionId,
  sourceName,
  initial,
  impact = null,
}: {
  kind: DefinitionKind;
  /** The definition being edited; absent for a new one. */
  d: DefinitionDetail | null;
  connectionId: string;
  sourceName: string;
  initial: string;
  /** What the change reaches once approved (impactOf), for an edit. */
  impact?: string | null;
}) {
  const base = `/knowledge/${PLURAL[kind]}`;
  const title = d ? `Edit ${d.title}` : `New ${kind}`;
  return (
    <>
      <TopBar
        crumbs={[
          { label: "Knowledge", href: "/knowledge" },
          { label: LABEL[kind], href: base },
          ...(d ? [{ label: d.title, href: `${base}/${d.id}` }, { label: "Edit" }] : [{ label: `New ${kind}` }]),
        ]}
      />
      <div className="flex-1 overflow-y-auto px-8 pt-8 pb-16">
        <div className="flex flex-col gap-6">
          <header className="flex items-start gap-4">
            <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl border border-border bg-surface-secondary">
              {kind === "metric" ? <Sigma className="size-5" aria-hidden /> : <Table2 className="size-5" aria-hidden />}
            </span>
            <div className="flex min-w-0 flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-display">{title}</h1>
                {d ? <DefinitionStatusChip status={d.status} /> : null}
                {d ? (
                  <Chip size="sm" variant="soft" className="font-mono">
                    {d.slug}
                  </Chip>
                ) : null}
              </div>
              <p className="text-body text-muted">
                {d
                  ? `Saving makes version ${d.version + 1}. It stays unverified until it passes its tests and an owner or admin approves it.`
                  : `A ${kind} on ${sourceName}. It's tested against the data once saved, and Ask uses it once it's approved.`}
              </p>
              {impact ? (
                <p className="flex items-center gap-1.5 text-small text-muted-tertiary">
                  <GitBranch className="size-3.5" aria-hidden />
                  {impact}
                </p>
              ) : null}
            </div>
          </header>
          <DefinitionEditor
            kind={kind}
            {...(d ? { id: d.id } : {})}
            connectionId={connectionId}
            sourceName={sourceName}
            initial={initial}
            version={d?.version ?? 0}
            path={`/sources/${sourceName}/${kind === "metric" ? "metrics" : "models"}/${d?.slug ?? `new_${kind}`}.yaml`}
            cancelHref={d ? `${base}/${d.id}` : base}
          />
        </div>
      </div>
    </>
  );
}

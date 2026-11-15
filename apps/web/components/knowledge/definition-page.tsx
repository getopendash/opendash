import { buttonVariants, Chip } from "@heroui/react";
import {
  type DatasetSpec,
  type DefinitionDerived,
  type DefinitionDetail,
  type DefinitionUsage,
  type FeedbackReport,
  formatNumber,
  type LoadedModel,
  type MetricSpec,
  metricFields,
  metricTimeColumn,
} from "@opendash/core";
import { ChangeBar, CodeBlock, LineDiff } from "@opendash/ui";
import {
  CircleCheck,
  CircleX,
  MessageSquare,
  MessageSquareText,
  Pencil,
  Sigma,
  Table2,
  TriangleAlert,
} from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { AskBeside } from "@/components/panel/ask-beside";
import { PageFocus } from "@/components/panel/page-focus";
import { TopBar } from "@/components/shell/top-bar";
import { ago, shortDate } from "@/lib/format";
import { lineDiff } from "@/lib/line-diff";
import { DefinitionStatusChip } from "./definition-status";
import { DefinitionTabs } from "./definition-tabs";
import { DiscardDraft } from "./discard-draft";
import { FeedbackReportCard } from "./feedback-report";
import { RefreshWhile } from "./refresh-while";
import { ReleaseDraft } from "./release-draft";
import { UsedBy } from "./used-by";

const FORMAT = { usd: "US dollars", number: "Number", percent: "Percent" } as const;
const DIRECTION = {
  higher_is_better: "Higher is better",
  lower_is_better: "Lower is better",
  neutral: "Neither up nor down is better",
} as const;

const CARDINALITY = { "n:1": "many-to-one", "1:1": "one-to-one", "1:n": "one-to-many" } as const;

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-small font-medium text-muted">{title}</h2>
        {aside ? <span className="text-small text-muted-tertiary">{aside}</span> : null}
      </div>
      {children}
    </section>
  );
}

function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="flex flex-col">
      {rows.map(([label, value]) => (
        <div key={label} className="flex gap-6 border-b border-border py-2.5 text-body">
          <dt className="w-36 shrink-0 text-muted">{label}</dt>
          <dd className="min-w-0 break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Grid({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-body">
        <thead>
          <tr className="border-b border-border text-left text-small text-muted-tertiary">
            {head.map((h) => (
              <th key={h} className="py-2 pe-6 font-normal last:pe-0">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows of a definition, in its order
            <tr key={r} className="border-b border-border">
              {row.map((cell, c) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: cells are positional
                <td key={c} className="py-2 pe-6 align-top last:pe-0">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const mono = (text: string) => <span className="font-mono text-small">{text}</span>;

/** "Tested against your data": each check with what it found. */
export function ChecksList({ derived, source }: { derived: DefinitionDerived | null; source: string }) {
  if (!derived) return <p className="text-small text-muted">OpenDash is testing this against {source}…</p>;
  return (
    <ul className="flex flex-col">
      {derived.checks.map((c) => (
        <li key={c.name} className="flex items-start gap-2.5 py-1.75 text-body">
          {c.status === "passed" ? (
            <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
          ) : c.status === "warn" ? (
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          ) : (
            <CircleX className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
          )}
          <span className="flex-1">
            {c.name === "Runs on your data" ? `Runs on ${source}` : c.name}
            {c.status === "failed" && c.detail ? (
              <span className="mt-0.5 block text-small text-danger">{c.detail}</span>
            ) : null}
          </span>
          {c.status !== "failed" && c.detail ? (
            <span className="shrink-0 text-small text-muted-tertiary">{c.detail}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

const month = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

/** A metric's latest value as its checks read it, and the change from the period before. */
function LatestValue({
  derived,
  format,
  now,
}: {
  derived: DefinitionDerived | null;
  format: MetricSpec["format"];
  now: number;
}) {
  const s = derived?.sample;
  const value = Number(s?.value);
  if (!s || s.value === null || Number.isNaN(value)) return null;
  const f = format === "usd" ? { currency: "USD", compact: true } : format === "percent" ? { percent: true } : {};
  const previous = Number(s.previous);
  const change =
    s.previous !== null && s.previous !== undefined && previous ? (value - previous) / Math.abs(previous) : null;
  return (
    <Section title="Latest value">
      <span className="text-number-lg tabular-nums">{formatNumber(value, f)}</span>
      <span className="flex flex-wrap items-center gap-1.5 text-small text-muted-tertiary">
        {s.period ? month.format(new Date(`${s.period}T00:00:00Z`)) : s.label}
        {change !== null ? (
          <>
            <span aria-hidden> · </span>
            <span className={change >= 0 ? "text-success" : "text-danger"}>
              {change >= 0 ? "up" : "down"} {formatNumber(Math.abs(change), { percent: true, decimals: 1 })}
            </span>
            from the month before
          </>
        ) : null}
      </span>
      <span className="text-micro text-muted-tertiary">As of the last test, {ago(derived?.checkedAt ?? "", now)}.</span>
    </Section>
  );
}

export function MetricOverview({ spec, model }: { spec: MetricSpec; model: LoadedModel | null }) {
  const dataset = model?.model.datasets.get(spec.dataset);
  const measure = dataset?.measures.find((m) => m.name === spec.measure);
  const time = dataset ? metricTimeColumn(spec, dataset) : null;
  const segments = [
    ...(dataset?.segments.filter((s) => s.default).map((s) => `${s.description ?? s.name} (always applied)`) ?? []),
    ...spec.segments.map((name) => dataset?.segments.find((s) => s.name === name)?.description ?? name),
  ];
  // A join key (plan_id) is listed through what it joins (plans.name), the way people ask.
  const joinKeys = new Set(dataset?.relationships.flatMap((r) => Object.keys(r.on)) ?? []);
  const fields = model
    ? metricFields(model.model, spec.name).filter(
        (f) => f.dimension && f.column.type !== "time" && !joinKeys.has(f.name),
      )
    : [];
  const datasetItem = model?.definitions.get(`dataset:${spec.dataset}`);
  return (
    <div className="flex flex-col gap-7">
      <p className="text-lead">{spec.description}</p>
      <Section title="Definition">
        <Facts
          rows={[
            [
              "Dataset",
              datasetItem ? (
                <Link
                  key="dataset"
                  href={`/knowledge/datasets/${datasetItem.id}`}
                  className="text-link hover:underline"
                >
                  {dataset?.label ?? spec.dataset}
                </Link>
              ) : (
                spec.dataset
              ),
            ],
            ["Measure", mono(`${spec.measure}: ${measure?.expr ?? "?"}`)],
            [
              "Time",
              time
                ? `By ${time} (UTC)${spec.default_grain ? `, usually by ${spec.default_grain}` : ""}`
                : "The current state: no time range",
            ],
            ["Segments", segments.length ? segments.join(" · ") : "None"],
            ["Format", FORMAT[spec.format ?? measure?.format ?? "number"]],
            ["Direction", DIRECTION[spec.direction]],
            ...(spec.synonyms.length ? [["Also called", spec.synonyms.join(", ")] as [string, ReactNode]] : []),
          ]}
        />
      </Section>
      {fields.length ? (
        <Section
          title="Group and filter by"
          aside={`${fields.length} fields · ${fields.filter((f) => f.name.includes(".")).length} through joins`}
        >
          <Grid
            head={["Field", "From", "Description"]}
            rows={fields.map((f) => {
              const ref = f.name.includes(".") ? f.name.split(".")[0] : null;
              const target = ref ? model?.model.datasets.get(ref) : null;
              return [
                mono(f.name),
                <span key="from" className="text-small text-muted">
                  {target ? `${target.label} (many-to-one)` : "This dataset"}
                </span>,
                <span key="d" className="text-small">
                  {f.column.description ?? f.column.synonyms.join(", ")}
                </span>,
              ];
            })}
          />
        </Section>
      ) : null}
    </div>
  );
}

export function DatasetOverview({ spec, model }: { spec: DatasetSpec; model: LoadedModel | null }) {
  const metrics = model
    ? [...model.model.metrics.values()]
        .filter((m) => m.dataset === spec.ref)
        .map((m) => ({
          m,
          id: model.definitions.get(`metric:${m.name}`)?.id,
        }))
    : [];
  const keys = new Set(spec.primary_key);
  const joins = new Map(spec.relationships.flatMap((r) => Object.keys(r.on).map((k) => [k, r] as const)));
  return (
    <div className="flex flex-col gap-7">
      {spec.description ? <p className="text-lead">{spec.description}</p> : null}
      <Section title="Definition">
        <Facts
          rows={[
            ["Grain", spec.grain.charAt(0).toUpperCase() + spec.grain.slice(1)],
            ["Key", mono(spec.primary_key.join(", "))],
            ["Time column", spec.time_column ? `${spec.time_column} (UTC)` : "None"],
            [
              "Joins",
              spec.relationships.length
                ? spec.relationships
                    .map(
                      (r) =>
                        `${model?.model.datasets.get(r.to)?.label ?? r.to} on ${Object.keys(r.on).join(", ")} (${CARDINALITY[r.type]})`,
                    )
                    .join(" · ")
                : "None",
            ],
            [
              "Segments",
              spec.segments.length
                ? spec.segments
                    .map((s) => `${s.description ?? s.name}${s.default ? " (always applied)" : ""}`)
                    .join(" · ")
                : "None",
            ],
          ]}
        />
      </Section>
      {spec.measures.length ? (
        <Section title="Measures">
          <Grid
            head={["Name", "Expression", "Format"]}
            rows={spec.measures.map((m) => [
              <span key="n" className="font-medium">
                {m.name}
              </span>,
              mono(m.expr),
              <span key="f" className="text-small text-muted">
                {FORMAT[m.format]}
              </span>,
            ])}
          />
        </Section>
      ) : null}
      <Section title="Columns" aside={`${spec.columns.length} columns`}>
        <Grid
          head={["Name", "Type", "Role", "Description"]}
          rows={spec.columns.map((c) => {
            const join = joins.get(c.name);
            const role = keys.has(c.name)
              ? "Key"
              : join
                ? "Join"
                : c.name === spec.time_column
                  ? "Time"
                  : c.dimension
                    ? "Dimension"
                    : null;
            return [
              mono(c.name),
              <span key="t" className="text-small text-muted">
                {c.type}
              </span>,
              role ? (
                <Chip key="r" size="sm" variant="soft">
                  {role}
                </Chip>
              ) : null,
              <span key="d" className="text-small">
                {join
                  ? `${model?.model.datasets.get(join.to)?.label ?? join.to} (${CARDINALITY[join.type]})`
                  : (c.description ?? "")}
              </span>,
            ];
          })}
        />
      </Section>
      {metrics.length ? (
        <Section title="Metrics on it">
          <ul className="flex flex-wrap gap-2">
            {metrics.map(({ m, id }) => (
              <li key={m.name}>
                <Link
                  href={id ? `/knowledge/metrics/${id}` : "/knowledge/metrics"}
                  className="flex items-center gap-1.5 rounded-xl border border-border px-2.5 py-1 text-small hover:bg-default"
                >
                  <Sigma className="size-3.5 text-muted" aria-hidden />
                  {m.label}
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </div>
  );
}

/** A definition's page. Its meaning and definition, its YAML, its versions, and what its tests found. */
export function DefinitionPage({
  d,
  model,
  canApprove,
  now,
  reports = [],
  usage,
}: {
  d: DefinitionDetail;
  model: LoadedModel | null;
  canApprove: boolean;
  now: number;
  /** Open reports on answers that used it. */
  reports?: FeedbackReport[];
  /** What depends on it (its Used by). */
  usage?: DefinitionUsage;
}) {
  const metric = d.kind === "metric";
  const spec = d.spec;
  // A newer version waiting over the released one: the analyst's draft, or a person's edit.
  const draft = d.released;
  const current = d.versions.find((v) => v.version === d.version);
  const changes = draft ? lineDiff(draft.body, d.body) : [];
  const changed = changes.filter((l) => l.kind === "added" || l.kind === "removed").length;
  const subline = [
    metric
      ? `Metric · on ${model?.model.datasets.get((spec as MetricSpec).dataset)?.label ?? (spec as MetricSpec).dataset}`
      : "Dataset",
    d.connectionName,
    `version ${d.version}`,
    // Who approved the released version and when stay with it while a draft waits.
    d.verifiedAt
      ? draft
        ? `version ${draft.version} verified ${shortDate(d.verifiedAt)}`
        : `verified ${shortDate(d.verifiedAt)}`
      : d.status === "proposed"
        ? "proposed by OpenDash"
        : null,
  ].filter(Boolean);
  return (
    <>
      <TopBar
        crumbs={[
          { label: "Knowledge", href: "/knowledge" },
          { label: metric ? "Metrics" : "Datasets", href: metric ? "/knowledge/metrics" : "/knowledge/datasets" },
          { label: d.title },
        ]}
        action={
          <>
            {/* The version shown, as Release does: one the analyst saves meanwhile is seen before it's approved. */}
            {d.status !== "verified" && canApprove && !draft ? (
              <ReleaseDraft id={d.id} title={d.title} version={d.version} checks={d.checks} verb="Approve" />
            ) : null}
            {canApprove ? (
              <Link
                href={`/knowledge/${metric ? "metrics" : "datasets"}/${d.id}/edit`}
                className={`${buttonVariants({ size: "sm", variant: "outline" })} gap-1`}
              >
                <Pencil className="size-3.5" aria-hidden />
                Edit
              </Link>
            ) : null}
            <AskBeside connectionId={d.connectionId}>
              <MessageSquareText className="size-3.5" aria-hidden />
              Ask about this
            </AskBeside>
          </>
        }
      />
      {/* The metric or dataset is attached to the question asked beside it: a released one, or for an
          owner or admin, who may have the analyst draft a change to it, one not released yet. */}
      <PageFocus
        focus={
          d.releasedVersion !== null || canApprove
            ? { item: { kind: d.kind, id: d.id, title: d.title }, connectionId: d.connectionId }
            : null
        }
      />
      <RefreshWhile active={d.derived === null} />
      <div className="flex-1 overflow-y-auto px-8 pt-8 pb-16">
        <div className="flex flex-col gap-6">
          <header className="flex items-start gap-4">
            <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl border border-border bg-surface-secondary">
              {metric ? <Sigma className="size-5" aria-hidden /> : <Table2 className="size-5" aria-hidden />}
            </span>
            <div className="flex min-w-0 flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-display">{d.title}</h1>
                <DefinitionStatusChip status={d.status} />
                <Chip size="sm" variant="soft" className="font-mono">
                  {d.slug}
                </Chip>
              </div>
              <p className="text-body text-muted">{subline.join(" · ")}</p>
            </div>
          </header>
          {draft ? (
            <ChangeBar
              title={current?.source === "agent" ? "The analyst drafted a change" : "A change waits for release"}
              detail={
                d.checks === "failed"
                  ? `v${draft.version} → v${d.version} · its tests failed, so Ask keeps version ${draft.version}`
                  : `v${draft.version} → v${d.version} · Ask uses version ${draft.version} until it's released`
              }
              actions={
                canApprove ? (
                  <>
                    <DiscardDraft id={d.id} title={d.title} version={d.version} releasedVersion={draft.version} />
                    <ReleaseDraft id={d.id} title={d.title} version={d.version} checks={d.checks} />
                  </>
                ) : null
              }
            />
          ) : null}
          <div className="flex flex-col gap-10 @5xl/page:flex-row">
            <div className="min-w-0 flex-1">
              {/* A new draft opens on its changes: the tabs start again for each version. */}
              <DefinitionTabs
                key={draft ? `draft-${d.version}` : "released"}
                tabs={[
                  ...(draft
                    ? [
                        {
                          id: "changes",
                          label: "Changes",
                          count: changed,
                          panel: (
                            <div className="flex flex-col gap-2">
                              <p className="text-small text-muted">
                                Version {d.version}, against version {draft.version}, the one Ask uses.
                                {current?.changeNote ? ` ${current.changeNote}` : ""}
                              </p>
                              <LineDiff lines={changes} empty="Its YAML is the same as the released version's." />
                            </div>
                          ),
                        },
                      ]
                    : []),
                  {
                    id: "overview",
                    label: "Overview",
                    panel: metric ? (
                      <MetricOverview spec={spec as MetricSpec} model={model} />
                    ) : (
                      <DatasetOverview spec={spec as DatasetSpec} model={model} />
                    ),
                  },
                  {
                    id: "definition",
                    label: "Definition",
                    panel: (
                      <div className="flex flex-col gap-2">
                        <p className="text-small text-muted">
                          As authored, in the Apache Ossie shape with OpenDash's extensions.
                        </p>
                        <CodeBlock code={d.body} label="Copy YAML" />
                      </div>
                    ),
                  },
                  {
                    id: "versions",
                    label: "Versions",
                    count: d.versions.length,
                    panel: (
                      <ul className="flex flex-col">
                        {d.versions.map((v) => (
                          <li
                            key={v.version}
                            className="flex items-baseline gap-4 border-b border-border py-2.5 text-body"
                          >
                            <span className="w-20 shrink-0 font-medium">Version {v.version}</span>
                            <span className="flex-1 text-muted">
                              {v.source === "agent" ? "By the analyst" : null}
                              {v.source === "agent" && v.changeNote ? ": " : null}
                              {v.changeNote ??
                                (v.source === "agent"
                                  ? null
                                  : v.source === "pack"
                                    ? "From the starter pack"
                                    : v.source === "user"
                                      ? "Edited"
                                      : `From ${v.source}`)}
                            </span>
                            {v.version === d.releasedVersion || (v.version === d.version && draft) ? (
                              <Chip size="sm" variant="soft">
                                {v.version === d.releasedVersion ? "Ask uses it" : "Draft"}
                              </Chip>
                            ) : null}
                            <span className="text-small text-muted-tertiary">{shortDate(v.createdAt)}</span>
                          </li>
                        ))}
                      </ul>
                    ),
                  },
                ]}
              />
            </div>
            <aside className="flex shrink-0 flex-col gap-7 @5xl/page:w-80">
              {usage ? (
                <Section title="Used by">
                  <UsedBy usage={usage} kind={d.kind} />
                </Section>
              ) : null}
              <Section title="Tested against your data">
                <ChecksList derived={d.derived} source={d.connectionName} />
              </Section>
              {metric ? <LatestValue derived={d.derived} format={(spec as MetricSpec).format} now={now} /> : null}
              {reports.length ? (
                <Section title="Reported as wrong" aside={`${reports.length} open`}>
                  <ul className="flex flex-col divide-y divide-border">
                    {reports.map((r) => (
                      <FeedbackReportCard key={r.id} report={r} now={now} canReview={canApprove} compact />
                    ))}
                  </ul>
                </Section>
              ) : null}
              <Section title="Recent answers">
                {d.recentAnswers.length ? (
                  <ul className="flex flex-col gap-1">
                    {d.recentAnswers.map((a) => (
                      <li key={a.threadId}>
                        <Link
                          href={`/ask/${a.threadId}`}
                          className="flex gap-2.5 rounded-xl px-2 py-1.5 hover:bg-default"
                        >
                          <MessageSquare className="mt-0.5 size-4 shrink-0 text-muted-tertiary" aria-hidden />
                          <span className="flex min-w-0 flex-col">
                            <span className="truncate text-body">{a.title}</span>
                            <span className="text-small text-muted-tertiary">{ago(a.at, now)}</span>
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-small text-muted-tertiary">
                    {d.releasedVersion !== null ? "No answers have used it yet." : "Answers use it once it's approved."}
                  </p>
                )}
              </Section>
            </aside>
          </div>
        </div>
      </div>
    </>
  );
}

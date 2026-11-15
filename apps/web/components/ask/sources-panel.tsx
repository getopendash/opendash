"use client";

import { Button, Tabs } from "@heroui/react";
import type { RunOutcome, RunView } from "@opendash/core";
import { PathLabel, StatusBadge } from "@opendash/ui";
import { useQueries } from "@tanstack/react-query";
import {
  ArrowLeft,
  BookA,
  Bookmark,
  CircleCheck,
  ListChecks,
  NotebookText,
  ShieldCheck,
  Sigma,
  Table2,
  TriangleAlert,
  X,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { memoryTextsAction } from "@/app/(app)/knowledge/memory/actions";
import { MakeMetricButton } from "@/components/knowledge/make-metric-button";
import { RecordsPanel } from "@/components/records/records-panel";
import { apiQueries } from "@/lib/api";
import { tokens, usd } from "@/lib/format";
import { checkedDetail, type RunStep } from "@/lib/run-steps";
import type { TracedRef } from "./answer-text";
import { gridCell, QueryCard } from "./query-card";
import { ReportNumber } from "./report-number";

type Answer = Extract<RunOutcome, { kind: "answer" }>;
type CrossCheckCell = NonNullable<Answer["crossChecks"]>[number]["headline"];

/** One cell of a cross-check, as its trace shows a cell: "q1 · row 1 · users = 8,647". */
const cellText = (c: CrossCheckCell) =>
  `${c.alias} · row ${c.row + 1} · ${c.column} = ${c.value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

/** A row of the Checks tab: the gate's check, a cross-check, or something a query's checks warned about. */
type CheckRow = Pick<RunStep, "key" | "status" | "label" | "detail">;

/** What the answer ran on: the model, the provider it went through, how long it thought, and whose bill. */
export type AnsweredWith = Pick<
  RunView["model"],
  "label" | "provider" | "providerLabel" | "billedTo" | "reasoningLabel"
>;

/**
 * "Claude Opus 5.5 through Amazon Bedrock · Deep thinking · on your AWS account · Took 5.2 s · 2 model calls ·
 * 28.1K tokens, 23K from cache · $0.0218": OpenDash's own calls are on OpenDash, so they don't
 * say whose bill. The cost is the provider's list price.
 */
const usageLine = (u: Record<string, number> & { seconds?: number }, model?: AnsweredWith) =>
  [
    model?.label ? `${model.label} through ${model.providerLabel}` : null,
    model ? `${model.reasoningLabel} thinking` : null,
    model && model.provider !== "opendash" ? `on ${model.billedTo.replace(/^Your /, "your ")}` : null,
    u.seconds !== undefined ? `Took ${u.seconds.toFixed(1)} s` : null,
    `${u.modelCalls} model ${u.modelCalls === 1 ? "call" : "calls"}`,
    `${tokens((u.inputTokens ?? 0) + (u.outputTokens ?? 0))} tokens, ${tokens(u.cachedInputTokens ?? 0)} from cache`,
    u.unpricedCalls ? null : usd(u.costUsd ?? 0),
  ]
    .filter(Boolean)
    .join(" · ");

const HOW = {
  glossary: "with every question",
  pinned: "pinned",
  table: "with its table",
  search: "found by search",
  question: "like the question",
  yours: "yours",
  attached: "attached",
  read: "followed",
} as const;

const ATTACHED_KIND = { metric: "Metric", dataset: "Dataset" } as const;

/** The metrics and datasets the asker attached to the conversation. */
function AttachedUses({
  items,
}: {
  items: { id: string; kind: string; title: string; version: number; draft?: boolean }[];
}) {
  if (!items.length) return null;
  return (
    <section className="flex flex-col gap-1.5 pt-2">
      <h3 className="text-small font-medium text-muted">Attached {items.length}</h3>
      {items.map((c) => (
        <Link
          key={c.id}
          href={`/knowledge/${c.kind === "dataset" ? "datasets" : "metrics"}/${c.id}`}
          className="flex items-center gap-2 rounded-xl border border-border px-3 py-2 hover:bg-default"
        >
          {c.kind === "dataset" ? (
            <Table2 className="size-3.5 shrink-0 text-muted" aria-hidden />
          ) : (
            <Sigma className="size-3.5 shrink-0 text-muted" aria-hidden />
          )}
          <span className="flex-1 truncate text-body">{c.title}</span>
          <span className="text-small text-muted-tertiary">
            {ATTACHED_KIND[c.kind as keyof typeof ATTACHED_KIND] ?? "Metric"} · v{c.version}
            {c.draft ? " (not released)" : ""} · attached
          </span>
        </Link>
      ))}
    </section>
  );
}

/**
 * The asker's memories a run was given: their text for their owner (read through the tenant policy), and only that
 * there were some for anyone else reading a shared conversation.
 */
function MemoryUses({ ids }: { ids: string[] }) {
  const [texts, setTexts] = useState<{ id: string; fact: string }[] | null>(null);
  const key = ids.join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: reads again only when the ids change
  useEffect(() => {
    let live = true;
    void memoryTextsAction(ids).then((t) => live && setTexts(t));
    return () => {
      live = false;
    };
  }, [key]);
  if (!ids.length) return null;
  return (
    <section className="flex flex-col gap-1.5 pt-2">
      <h3 className="text-small font-medium text-muted">
        {texts?.length ? "Your memory" : "The asker's memory"} {ids.length}
      </h3>
      {texts?.length ? (
        texts.map((m) => (
          <Link
            key={m.id}
            href="/knowledge/memory"
            className="flex items-center gap-2 rounded-xl border border-border px-3 py-2 hover:bg-default"
          >
            <Bookmark className="size-3.5 shrink-0 text-muted" aria-hidden />
            <span className="flex-1 truncate text-body">{m.fact}</span>
            <span className="text-small text-muted-tertiary">only you</span>
          </Link>
        ))
      ) : (
        <p className="text-small text-muted-tertiary">
          {texts === null ? "…" : "Their own preferences, which only they can see."}
        </p>
      )}
    </section>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-4 border-b border-border py-2.5 text-body">
      <dt className="w-24 shrink-0 text-muted">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

type Cell = TracedRef["citations"][number];

/** The gate's derived functions (core/answer/gate.ts), written out with the cells' values. */
const FORMULA: Record<string, (v: string[]) => string> = {
  pct: ([a, b]) => `(${a} − ${b}) ÷ ${b}`,
  delta: ([a, b]) => `${a} − ${b}`,
  ratio: ([a, b]) => `${a} ÷ ${b}`,
  share: ([a, b]) => `${a} ÷ ${b}`,
  sum: (v) => v.join(" + "),
  avg: (v) => `(${v.join(" + ")}) ÷ ${v.length}`,
};

/** The number being traced, its cells, how it was computed, and the queries it came from (SQL, values, result). */
function ValueTrace({
  trace,
  runId,
  feedback,
  onBack,
  showSource,
}: {
  trace: TracedRef;
  runId: string;
  feedback: boolean;
  onBack: () => void;
  /** The run read more than one source: each query card names its own. */
  showSource: boolean;
}) {
  const ids = [...new Set(trace.citations.map((c) => c.queryRunId))];
  const cards = useQueries({
    queries: ids.map((queryRunId) => apiQueries.queries.get.queryOptions({ input: { queryRunId } })),
  });
  const byId = new Map(cards.flatMap((q, i) => (q.data ? [[ids[i], q.data] as const] : [])));
  const value = (c: Cell) => {
    const card = byId.get(c.queryRunId);
    const index = card?.columns.findIndex((col) => col.name === c.column) ?? -1;
    const v = index >= 0 ? card?.preview[c.row]?.[index] : undefined;
    return v === undefined ? null : gridCell(v);
  };
  const cited = ids.map((id) => byId.get(id)).filter((c) => c !== undefined);
  const definitions = [
    ...new Map(cited.flatMap((c) => c.definitions.filter((d) => d.kind === "metric")).map((d) => [d.id, d])).values(),
  ];
  const onMetric = cited.length > 0 && cited.every((c) => c.path === "metric");
  const fn = /^\s*(pct|delta|ratio|share|sum|avg)\s*\(/.exec(trace.ref)?.[1];
  const values = trace.citations.map(value);
  const formula = fn && values.every((v) => v !== null) ? FORMULA[fn]?.(values as string[]) : null;
  // A number read from one measure cell of a metric query has records behind it: the rows it counts.
  const [records, setRecords] = useState(false);
  const only = trace.citations.length === 1 ? trace.citations[0] : undefined;
  const measures = only
    ? (byId.get(only.queryRunId)?.metricQuery as { metrics?: string[] } | null | undefined)?.metrics
    : undefined;
  const hasRecords = Boolean(only && !fn && onMetric && measures?.includes(only.column));
  if (records && only) {
    return (
      <RecordsPanel
        queryRunId={only.queryRunId}
        row={only.row}
        display={trace.display}
        onBack={() => setRecords(false)}
        backLabel="Where this number comes from"
      />
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <button
        type="button"
        onClick={onBack}
        className="flex w-fit items-center gap-1.5 text-small text-muted hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        All sources
      </button>
      <div className="flex flex-col gap-1">
        <span className="text-number-lg tabular-nums">{trace.display}</span>
        <span className="text-small text-muted-tertiary">
          {fn ? "Computed by OpenDash from the cells below, never by the model" : "Read from one query cell"}
        </span>
        {hasRecords ? (
          <Button size="sm" variant="secondary" className="mt-2 w-fit" onPress={() => setRecords(true)}>
            <Table2 className="size-4" aria-hidden />
            View records
          </Button>
        ) : null}
      </div>
      <dl className="flex flex-col">
        <Fact label={trace.citations.length > 1 ? "Source cells" : "Source cell"}>
          <span className="flex flex-col gap-0.5 font-mono text-small">
            {trace.citations.map((c, i) => (
              <span key={`${c.queryRunId}-${c.row}-${c.column}`}>
                {c.alias} · row {c.row + 1} · {c.column}
                {values[i] !== null ? ` = ${values[i]}` : ""}
              </span>
            ))}
          </span>
        </Fact>
        {formula ? (
          <Fact label="Formula">
            <span className="font-mono text-small">{formula}</span>
          </Fact>
        ) : null}
        <Fact label="Definition">
          {definitions.length ? (
            <span className="flex flex-col gap-0.5">
              {definitions.map((d) => (
                <Link key={d.id} href={`/knowledge/metrics/${d.id}`} className="text-link hover:underline">
                  {d.title} v{d.version}
                  {d.status === "verified" ? " · verified" : ""}
                </Link>
              ))}
            </span>
          ) : (
            `None (computed in ${[...new Set(trace.citations.map((c) => c.alias))].join(", ")})`
          )}
        </Fact>
        <Fact label="Path">
          <span className="flex flex-wrap items-center gap-2">
            {onMetric ? (
              <>
                <PathLabel path="metric" /> Compiled from verified definitions
              </>
            ) : (
              <>
                <PathLabel path="unmodelled" /> SQL over the tables
              </>
            )}
          </span>
        </Fact>
      </dl>
      {ids.map((id) => (
        <QueryCard
          key={id}
          queryRunId={id}
          highlight={trace.citations.filter((c) => c.queryRunId === id)}
          defaultOpen
          showSource={showSource}
        />
      ))}
      {feedback && trace.citations[0] ? (
        <ReportNumber runId={runId} queryRunId={trace.citations[0].queryRunId} claimKey={trace.ref} />
      ) : null}
    </div>
  );
}

/**
 * The Sources panel for one answer, in this tab order: Interpretation · Context · Queries · Checks ·
 * Couldn't verify. Definitions shows once answers use verified definitions; an Unmodelled answer has none.
 */
export function SourcesPanel({
  runId,
  answer,
  steps,
  source,
  trace,
  usage,
  model,
  verifyQuestion,
  numberFeedback = true,
  canDraft = false,
  onBack,
  onClose,
  embedded = false,
}: {
  /** "This number is wrong" on a traced number: off in a report, whose reader may not see the conversation. */
  numberFeedback?: boolean;
  /** The reader asks (not a viewer): a query offers Make this a metric. */
  canDraft?: boolean;
  /** The run's question, when the viewer may save its metric queries as verified (owners and admins). */
  verifyQuestion?: string | null;
  /** What the run used: shown under its checks. */
  usage?: Record<string, number> & { seconds?: number };
  /** The model that answered, and what it ran on. */
  model?: AnsweredWith;
  answer: Answer | null;
  steps: RunStep[];
  source: string;
  trace: TracedRef | null;
  /** The run whose answer this is (for feedback on its numbers). */
  runId: string;
  onBack: () => void;
  onClose: () => void;
  /** Drawn inside the panel beside a page: its header is the panel's. */
  embedded?: boolean;
}) {
  // This run's queries, then any earlier one in the conversation the answer cites (a retry can answer from a query
  // the stopped run finished).
  const ran = steps.flatMap((s) => (s.queryRunId ? [s.queryRunId] : []));
  // A step on another source means the run read more than one: its query cards name theirs.
  const several = steps.some((s) => s.source);
  const segments = answer?.segments;
  const citedIds = [
    ...(segments?.markdown ?? []),
    ...(segments?.caveats.flat() ?? []),
    ...(segments?.interpretation.flat() ?? []),
  ].flatMap((s) => ("ref" in s ? s.citations.map((c) => c.queryRunId) : []));
  const cited = new Set(citedIds);
  // The queries that counted the headline another way: listed though the answer doesn't cite them.
  const crossChecks = answer?.crossChecks ?? [];
  const checking = new Set(crossChecks.map((c) => c.check.queryRunId));
  const queries = [...new Set([...ran, ...citedIds, ...checking])];
  // Which came from an earlier run is known only while this run's events are kept (days); the answer is kept for good.
  const earlier = new Set(ran.length ? queries.filter((id) => !ran.includes(id)) : []);
  const noteFor = (id: string) =>
    !cited.has(id)
      ? checking.has(id)
        ? "Cross-check: the headline counted another way"
        : "Not cited in the answer"
      : earlier.has(id)
        ? "Ran earlier in this conversation"
        : null;
  // The metrics the answer's queries compiled from (the panel's "Definitions used").
  const cards = useQueries({
    queries: queries.map((queryRunId) => apiQueries.queries.get.queryOptions({ input: { queryRunId } })),
  });
  const used = [
    ...new Map(
      cards.flatMap((c) => (c.data?.definitions ?? []).filter((d) => d.kind === "metric")).map((d) => [d.id, d]),
    ).values(),
  ];
  const matched = steps.filter((s) => s.label.startsWith("Matched"));
  const problems = answer && !answer.verified ? answer.problems : [];
  // What was checked: the gate (from its step, or the answer once the events are gone), each cross-check with both
  // cells, what each query's checks warned about, and anything else that didn't go as planned.
  const checkStep = steps.find((s) => s.key === "check");
  const checks: CheckRow[] = [
    ...(checkStep
      ? [checkStep]
      : answer?.checked
        ? [
            {
              key: "check",
              status: answer.verified ? ("ok" as const) : ("warn" as const),
              label: "Checked the results",
              detail: checkedDetail(answer.verified, answer.checked),
            },
          ]
        : []),
    ...crossChecks.map((c, i) => ({
      key: `cross-${i}`,
      status: c.agrees ? ("ok" as const) : ("warn" as const),
      label: c.agrees ? "Cross-check passed" : "Cross-check: two definitions",
      detail: c.agrees
        ? `${cellText(c.headline)} and ${cellText(c.check)} agree`
        : `${cellText(c.headline)}, ${cellText(c.check)}: ${c.differsBecause ?? "they differ"}`,
    })),
    ...cards.flatMap(({ data: card }) =>
      card
        ? [
            ...card.warnings.map((w, i) => ({
              key: `${card.id}-${i}`,
              status: "warn" as const,
              label: `${card.alias ?? "Query"} · ${card.title ?? "Query"}`,
              detail: w,
            })),
            ...(card.truncated
              ? [
                  {
                    key: `${card.id}-cut`,
                    status: "warn" as const,
                    label: `${card.alias ?? "Query"} · ${card.title ?? "Query"}`,
                    detail: `Showing the first ${card.rows?.toLocaleString("en-US")} rows`,
                  },
                ]
              : []),
          ]
        : [],
    ),
    // A query's own warnings are listed above, from its card.
    ...steps.filter((s) => s.status === "warn" && !s.alias && s.key !== "check"),
  ];
  return (
    <aside
      aria-label="Sources"
      className={`flex h-full w-full flex-col ${embedded ? "pt-3" : "border-border @5xl/page:w-inspector @5xl/page:border-l"}`}
    >
      {embedded ? null : (
        <header className="flex h-12 shrink-0 items-center justify-between px-4">
          <h2 className="text-body font-semibold">Sources</h2>
          <Button isIconOnly size="sm" variant="ghost" aria-label="Close sources" onPress={onClose}>
            <X className="text-muted" />
          </Button>
        </header>
      )}
      <div className="flex-1 overflow-y-auto px-4 pb-6">
        {trace ? (
          <ValueTrace trace={trace} runId={runId} feedback={numberFeedback} onBack={onBack} showSource={several} />
        ) : (
          <Tabs variant="secondary" defaultSelectedKey="queries">
            <Tabs.ListContainer>
              <Tabs.List aria-label="Sources sections">
                {[
                  { id: "interpretation", label: "Interpretation" },
                  { id: "context", label: "Context" },
                  { id: "queries", label: "Queries" },
                  { id: "checks", label: "Checks" },
                  ...(problems.length ? [{ id: "unverified", label: "Couldn't verify" }] : []),
                ].map((t) => (
                  <Tabs.Tab key={t.id} id={t.id}>
                    {t.label}
                    {t.id === "queries" && queries.length ? (
                      <span className="ms-1 text-small text-muted-tertiary">{queries.length}</span>
                    ) : null}
                    {t.id === "unverified" ? (
                      <span className="ms-1 text-small text-warning">{problems.length}</span>
                    ) : null}
                    <Tabs.Indicator />
                  </Tabs.Tab>
                ))}
              </Tabs.List>
            </Tabs.ListContainer>
            <Tabs.Panel id="interpretation" className="flex flex-col gap-2 pt-4">
              <p className="text-small text-muted">The defaults OpenDash chose to answer the question as asked.</p>
              {answer?.interpretation.length ? (
                <ul className="flex flex-col gap-1.5">
                  {answer.interpretation.map((i) => (
                    <li key={i} className="rounded-xl border border-border px-3 py-2 text-body">
                      {i}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-body text-muted-tertiary">No defaults were needed.</p>
              )}
            </Tabs.Panel>
            <Tabs.Panel id="context" className="flex flex-col gap-2 pt-4">
              <p className="text-small text-muted">
                What the analyst was given for this answer, besides your question: data, fenced and labelled, never
                instructions. Skills are the exception: ways of working your team approved, which it follows within its
                rules.
              </p>
              <AttachedUses items={(answer?.context ?? []).filter((c) => c.kind in ATTACHED_KIND)} />
              {(["skill", "verified_query", "term", "guide"] as const).map((kind) => {
                const items = (answer?.context ?? []).filter((c) => c.kind === kind);
                if (!items.length) return null;
                return (
                  <section key={kind} className="flex flex-col gap-1.5 pt-2">
                    <h3 className="text-small font-medium text-muted">
                      {kind === "term"
                        ? "Glossary"
                        : kind === "guide"
                          ? "Guides"
                          : kind === "skill"
                            ? "Skills"
                            : "Verified queries"}{" "}
                      {items.length}
                    </h3>
                    {items.map((c) => (
                      <Link
                        key={c.id}
                        href={`/knowledge/${kind === "term" ? "glossary" : kind === "guide" ? "guides" : kind === "skill" ? "skills" : "verified"}/${c.id}`}
                        className="flex items-center gap-2 rounded-xl border border-border px-3 py-2 hover:bg-default"
                      >
                        {kind === "term" ? (
                          <BookA className="size-3.5 shrink-0 text-muted" aria-hidden />
                        ) : kind === "guide" ? (
                          <NotebookText className="size-3.5 shrink-0 text-muted" aria-hidden />
                        ) : kind === "skill" ? (
                          <ListChecks className="size-3.5 shrink-0 text-muted" aria-hidden />
                        ) : (
                          <ShieldCheck className="size-3.5 shrink-0 text-accent" aria-hidden />
                        )}
                        <span className="flex-1 truncate text-body">{c.title}</span>
                        <span className="text-small text-muted-tertiary">
                          v{c.version}
                          {c.draft ? " (draft)" : ""} ·{" "}
                          {c.followed ? "followed" : c.kind === "skill" && c.how === "attached" ? "chosen" : HOW[c.how]}
                        </span>
                      </Link>
                    ))}
                  </section>
                );
              })}
              <MemoryUses ids={(answer?.context ?? []).filter((c) => c.kind === "memory").map((c) => c.id)} />
              <h3 className="pt-2 text-small font-medium text-muted">Catalog</h3>
              <p className="text-body">
                The catalog of {source}: its tables, columns, joins and the values it indexed.
              </p>
              {matched.map((m) => (
                <p key={m.key} className="text-small text-muted">
                  {m.label} · {m.detail}
                </p>
              ))}
            </Tabs.Panel>
            <Tabs.Panel id="queries" className="flex flex-col gap-2.5 pt-4">
              {used.length ? (
                <section className="flex flex-col gap-1.5 pb-2">
                  <h3 className="text-small font-medium text-muted">Definitions used</h3>
                  {used.map((d) => (
                    <Link
                      key={d.id}
                      href={`/knowledge/metrics/${d.id}`}
                      className="flex items-center gap-2 rounded-xl border border-border px-3 py-2 hover:bg-default"
                    >
                      <Sigma className="size-3.5 shrink-0 text-muted" aria-hidden />
                      <span className="flex-1 truncate text-body">{d.title}</span>
                      <span className="text-small text-muted-tertiary">v{d.version}</span>
                      {d.status === "verified" ? <StatusBadge status="verified" /> : null}
                    </Link>
                  ))}
                  <h3 className="pt-2 text-small font-medium text-muted">Queries</h3>
                </section>
              ) : null}
              {queries.length ? (
                queries.map((id) => (
                  <QueryCard
                    key={id}
                    queryRunId={id}
                    showSource={several}
                    {...(noteFor(id) ? { note: noteFor(id) as string } : {})}
                    {...(verifyQuestion && ran.includes(id) ? { verify: { question: verifyQuestion } } : {})}
                    {...(canDraft ? { action: <MakeMetricButton queryRunId={id} /> } : {})}
                  />
                ))
              ) : (
                <p className="text-body text-muted-tertiary">No queries ran.</p>
              )}
            </Tabs.Panel>
            <Tabs.Panel id="checks" className="flex flex-col gap-2 pt-4">
              {checks.length ? (
                checks.map((c) => (
                  <div key={c.key} className="flex items-start gap-2.5 text-body">
                    {c.status === "ok" ? (
                      <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
                    ) : (
                      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
                    )}
                    <span className="flex flex-col">
                      {c.label}
                      {c.detail ? <span className="text-small text-muted-tertiary">{c.detail}</span> : null}
                    </span>
                  </div>
                ))
              ) : (
                <p className="text-body text-muted-tertiary">No checks yet.</p>
              )}
              {usage?.modelCalls ? (
                <p className="mt-2 border-t border-border pt-3 text-small text-muted-tertiary">
                  {usageLine(usage, model)}
                </p>
              ) : null}
            </Tabs.Panel>
            {problems.length ? (
              <Tabs.Panel id="unverified" className="flex flex-col gap-2 pt-4">
                <p className="text-small text-muted">
                  The answer gate couldn't check these, so the answer is marked Unverified.
                </p>
                <ul className="flex list-disc flex-col gap-1 ps-5 text-body">
                  {problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </Tabs.Panel>
            ) : null}
          </Tabs>
        )}
      </div>
    </aside>
  );
}

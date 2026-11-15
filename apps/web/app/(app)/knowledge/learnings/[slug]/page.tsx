import { buttonVariants, Chip } from "@heroui/react";
import { getTopic, isTopicSlug, meaningLine, type TopicMeaning } from "@opendash/core";
import { withTenant } from "@opendash/db";
import { CheckCircle2, CircleDashed, Pencil, Sigma, Table2, XCircle } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { TopicCards } from "@/components/learning/learning-card";
import { TopicFlow } from "@/components/learning/topic-flow";
import { TopicMemories } from "@/components/learning/topic-memories";
import { TopBar } from "@/components/shell/top-bar";
import { requireTenant } from "@/lib/auth";
import { count } from "@/lib/format";
import { canVerify } from "@/lib/knowledge";
import { TOPIC_STATE } from "@/lib/topics";

export const metadata: Metadata = { title: "Learning · OpenDash" };

const day = (at: string) => new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" });

function Section({ id, title, hint, children }: { id?: string; title: string; hint?: string; children: ReactNode }) {
  return (
    <section id={id} className="flex scroll-mt-4 flex-col gap-2.5">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-title">{title}</h2>
        {hint ? <p className="max-w-reading text-small text-muted">{hint}</p> : null}
      </div>
      {children}
    </section>
  );
}

/** A meaning as the topic shows it: in a line, what else it's called, what it isn't. */
function Meaning({ m }: { m: TopicMeaning }) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-body">
        <span className="font-medium">{m.term}</span> means{" "}
        <span className="font-mono text-small">{meaningLine(m)}</span>
        {m.column && m.means ? <span className="text-muted">: {m.means}</span> : null}
      </p>
      {m.synonyms.length ? <p className="text-small text-muted">Also called: {m.synonyms.join(" · ")}</p> : null}
      {m.not.length ? (
        <p className="text-small text-muted">
          Not the same as: <span className="font-mono">{m.not.join(", ")}</span>
        </p>
      ) : null}
    </div>
  );
}

/**
 * One topic: what it means (and a proposed change beside it), its learnings and how each was decided,
 * your own memories about it, the guides and definitions on its tables, its tests, and for an owner or admin how many
 * answers lately read a table it isn't.
 */
export default async function TopicPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const name = decodeURIComponent(slug);
  if (!isTopicSlug(name)) notFound();
  const viewer = await requireTenant();
  const orgId = viewer.ctx.orgId;
  const approver = canVerify(viewer.role);
  const topic = await withTenant({ orgId, userId: viewer.user.id }, (tx) =>
    getTopic(tx, { orgId, userId: viewer.user.id, approver }, name),
  );
  if (!topic) notFound();
  const state = TOPIC_STATE[topic.state];
  return (
    <>
      <TopBar
        crumbs={[
          { label: "Knowledge", href: "/knowledge" },
          { label: "Learnings", href: "/knowledge/learnings" },
          { label: topic.title },
        ]}
      />
      <div className="flex-1 overflow-y-auto px-8 pt-8 pb-16">
        <div className="flex flex-col gap-8">
          <header className="flex flex-col gap-3">
            <div className="flex items-start justify-between gap-4">
              <h1 className="text-display">{topic.title}</h1>
              <span className="flex shrink-0 items-center gap-2">
                <Chip size="sm" variant="soft" color={state.color}>
                  {state.label}
                </Chip>
                {approver && topic.termId ? (
                  <Link
                    href={`/knowledge/glossary/${topic.termId}`}
                    className={buttonVariants({ size: "sm", variant: "outline" })}
                  >
                    <Pencil className="size-3.5" aria-hidden />
                    Edit the term
                  </Link>
                ) : null}
              </span>
            </div>
            {topic.released ? <Meaning m={topic.released} /> : null}
            {topic.proposed ? (
              <div className="flex flex-col gap-1.5 rounded-xl border border-accent p-3">
                <span className="text-small font-medium text-accent">
                  {topic.released ? "A change waiting for a tap" : "Proposed, not the team's yet"}
                </span>
                <Meaning m={topic.proposed} />
              </div>
            ) : null}
          </header>

          {topic.graph && topic.graph.nodes.length > 1 ? (
            <Section
              title="What it's connected to"
              hint="Hover a box for its whole name and what it is; click to open it."
            >
              <TopicFlow graph={topic.graph} />
            </Section>
          ) : null}

          {topic.cards.length ? (
            <Section
              id="how-it-was-learned"
              title="How it was learned"
              hint="Its learnings, newest first: what was said, its check and test, and how it was decided."
            >
              <TopicCards cards={topic.cards} />
            </Section>
          ) : null}

          {topic.yourMemories.length ? (
            <Section title="Your memories about it" hint="Yours alone: they shape your answers, nobody else's.">
              <TopicMemories memories={topic.yourMemories} teamHasIt={topic.state === "team"} />
            </Section>
          ) : null}

          {topic.guides.length || topic.definitions.length ? (
            <Section id="on-its-table" title="On its table" hint="Guides and definitions on the table it means.">
              <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border">
                {topic.guides.map((g) => (
                  <li key={g.id}>
                    <Link
                      href={`/knowledge/guides/${g.id}`}
                      className="flex items-center gap-2.5 px-3 py-2 hover:bg-surface-secondary"
                    >
                      <Pencil className="size-3.5 text-muted" aria-hidden />
                      <span className="text-body">{g.title}</span>
                      <span className="text-small text-muted">Guide</span>
                    </Link>
                  </li>
                ))}
                {topic.definitions.map((d) => (
                  <li key={d.id}>
                    <Link
                      href={`/knowledge/${d.kind === "metric" ? "metrics" : "datasets"}/${d.id}`}
                      className="flex items-center gap-2.5 px-3 py-2 hover:bg-surface-secondary"
                    >
                      {d.kind === "metric" ? (
                        <Sigma className="size-3.5 text-muted" aria-hidden />
                      ) : (
                        <Table2 className="size-3.5 text-muted" aria-hidden />
                      )}
                      <span className="text-body">{d.title}</span>
                      <span className="text-small text-muted">{d.kind === "metric" ? "Metric" : "Dataset"}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          {topic.testCases.length ? (
            <Section title="Tests" hint="Asked every night: the answer must still read the table and filter it means.">
              <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border">
                {topic.testCases.map((c) => (
                  <li key={c.id} className="flex items-center gap-2.5 px-3 py-2">
                    {c.verdict === "pass" ? (
                      <CheckCircle2 className="size-3.5 shrink-0 text-success" aria-hidden />
                    ) : c.verdict ? (
                      <XCircle className="size-3.5 shrink-0 text-danger" aria-hidden />
                    ) : (
                      <CircleDashed className="size-3.5 shrink-0 text-muted" aria-hidden />
                    )}
                    <span className="min-w-0 flex-1 text-body">{c.question}</span>
                    <span className="shrink-0 text-small text-muted-tertiary">
                      {c.verdict
                        ? `${c.verdict === "pass" ? "Passed" : c.verdict === "error" ? "Couldn't run" : "Didn't pass"}${c.at ? ` · ${day(c.at)}` : ""}`
                        : "Not run yet"}
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          {topic.readNot?.length ? (
            <Section
              title="Answers that read what it isn't"
              hint="In the last 30 days: answers whose queries read a table it isn't (counts only, never the answers)."
            >
              <ul className="flex flex-col gap-1 text-body">
                {topic.readNot.map((r) => (
                  <li key={r.table} className="flex items-baseline gap-2">
                    <span className="font-mono text-small">{r.table}</span>
                    <span className="text-muted">{r.answers ? count(r.answers, "answer") : "none"}</span>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}
        </div>
      </div>
    </>
  );
}

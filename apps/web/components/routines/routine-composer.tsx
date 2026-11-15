"use client";

import { Button, toast } from "@heroui/react";
import type { ComposerChoices, ComposerOutcome, ComposerPart, ComposerPatch } from "@opendash/core";
import {
  asksOpenDash,
  destinationWords,
  displayMetric,
  needsManager,
  nextOccurrence,
  type RoutineSpec,
  routineSentence,
  ScheduleRule,
  specProblem,
  VIEWERS_DONT_ASK,
} from "@opendash/core/routines";
import { RoutineSentence, type RoutineSentencePart, TriggerCard } from "@opendash/ui";
import { Activity, ArrowRight, CalendarClock, Check, FileText, Info, Users } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { saveRoutineAction } from "@/app/(app)/routines/actions";
import { TopBar } from "@/components/shell/top-bar";
import {
  type ComposerSlack,
  type Draft,
  draftProblem,
  emptyDraft,
  PRESETS,
  parseLine,
  partsTouched,
  specOf,
  withOnlySource,
  withPatch,
} from "@/lib/routine-draft";
import { type HappensNames, whatHappens, whenLine } from "@/lib/routine-words";
import { FoundTell, FoundWhen, ScheduledWhat, ScheduleWhen, SectionHead, Where } from "./composer-sections";
import { DescribeIt } from "./describe-it";

/** The starts that ask OpenDash (a written summary, a question): not a viewer's. */
const ASKING_PRESETS = new Set(["ask"]);

/**
 * The routine composer: one sentence, built by picking what starts it, what it does and who hears. As
 * each part is picked, "What happens" says what will happen and whether it writes a report. A new routine starts from
 * one of a few presets; an existing one keeps its kind of trigger.
 */
export function RoutineComposer({
  id,
  initial,
  choices,
  members,
  me,
  ownerId,
  canManage,
  canAsk,
  watching,
  workspace,
  fromPreset,
  slack,
}: {
  /** The routine being changed; null for a new one. */
  id: string | null;
  initial: Draft;
  choices: ComposerChoices;
  members: { userId: string; name: string }[];
  me: string;
  ownerId: string;
  canManage: boolean;
  /** Not a viewer: a question, a written summary, working out why and Describe it are theirs. */
  canAsk: boolean;
  /** The workspace's own Watching: what's unusual, kept in Insights. */
  watching: boolean;
  workspace: string;
  /** Offer the Start from list (a new routine that nothing filled in). */
  fromPreset: boolean;
  slack: ComposerSlack;
}) {
  const router = useRouter();
  const [raw, setDraft] = useState(initial);
  // One source to ask: it's the question's, however the draft got here.
  const draft = withOnlySource(raw, choices.sources);
  const [saving, setSaving] = useState(false);
  // Describe it: the parts it asked about, until they're answered, and the names it couldn't place.
  const [asked, setAsked] = useState<Set<ComposerPart>>(new Set());
  const [unplaced, setUnplaced] = useState<string[]>([]);
  // A part picked by hand is settled: what Describe it asked about there, and the names it couldn't place in Where.
  const set = (patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    const touched = partsTouched(patch);
    if (touched.length) setAsked((a) => new Set([...a].filter((p) => !touched.includes(p as never))));
    if (touched.includes("where")) setUnplaced([]);
  };
  const place = { me, members, slack };
  const proposed = (o: ComposerOutcome) => {
    const { draft: next, unplaced: missed } = withPatch(
      { ...o.draft, userIds: [], slack: [] },
      { people: o.people, channels: o.channels },
      place,
    );
    setDraft(next);
    setAsked(new Set(o.open));
    setUnplaced(missed);
  };
  const answered = (part: ComposerPart, patch: ComposerPatch, settled: boolean) => {
    const { draft: next, unplaced: missed } = withPatch(draft, patch, place);
    setDraft(next);
    setUnplaced((u) => [...new Set([...u, ...missed])]);
    if (settled) setAsked((a) => new Set([...a].filter((p) => p !== part)));
  };
  const cleared = () => {
    setDraft(initial.trigger ? initial : emptyDraft(me));
    setAsked(new Set());
    setUnplaced([]);
  };
  const examples = (() => {
    const [m1, m2] = choices.metrics;
    return [
      m1 ? `Every Monday at 8, email me how ${m1.title} moved last week` : null,
      m1 ? `Tell me when ${m1.title} is unusual` : null,
      m2 ? `Email me when ${m2.title} drops a lot` : null,
      "Every Friday at 4, ask what changed this week",
    ].filter((x): x is string => Boolean(x));
  })();
  const when = useRef<HTMLElement>(null);
  const what = useRef<HTMLElement>(null);
  const where = useRef<HTMLElement>(null);

  const firstMetric = choices.metrics.find((m) => m.id === draft.metricIds[0]);
  const spec = specOf(draft, firstMetric?.format ?? null);
  const problem = draftProblem(draft, firstMetric?.format ?? null) ?? specProblem(spec);
  const noOne = !watching && draft.userIds.length === 0 && draft.slack.length === 0;
  const channels = watching ? [] : draft.slack.map((c) => `#${c.name}`);
  const blocker =
    problem ??
    (!canAsk && draft.trigger && asksOpenDash(spec as RoutineSpec)
      ? VIEWERS_DONT_ASK
      : noOne
        ? "Pick who it's for."
        : null);

  const people = draft.userIds.map((u) => ({
    name: members.find((m) => m.userId === u)?.name ?? "someone who left",
    isViewer: u === me,
  }));
  const metrics = choices.metrics.filter((m) => draft.metricIds.includes(m.id));
  const lineValue = draft.condition === "crosses" && firstMetric ? parseLine(draft.line, firstMetric.format) : null;
  const line = lineValue !== null && firstMetric ? displayMetric(firstMetric.format, lineValue) : null;

  const rule = draft.trigger === "schedule" ? ScheduleRule.safeParse((spec as { rule: unknown }).rule) : null;
  const next: string[] = [];
  if (rule?.success) {
    let after = new Date();
    for (let i = 0; i < 3; i++) {
      after = nextOccurrence(rule.data, choices.tz, after);
      next.push(after.toISOString());
    }
  }

  // The sentence as it stands, its parts still to pick in amber.
  const sentence = ((): RoutineSentencePart[] => {
    if (!draft.trigger) {
      return [
        { text: "When", role: "when", open: true },
        { text: " " },
        { text: "what", role: "what", open: true },
        { text: " " },
        { text: "where", role: "where", open: true },
      ];
    }
    const s = { ...(spec as RoutineSpec) };
    if (s.trigger === "found" && s.condition.kind === "crosses" && lineValue === null) {
      s.condition = { ...s.condition, value: 0 };
    }
    const parts = routineSentence(s, {
      metrics: metrics.length ? metrics.map((m) => m.title) : ["a metric"],
      line: line ?? "a line",
      people: watching ? [] : people.length || channels.length ? people : [{ name: "whom", isViewer: false }],
      channels,
    });
    const openWhen =
      draft.trigger === "schedule"
        ? !rule?.success
        : !metrics.length || (draft.condition === "crosses" && lineValue === null);
    const openWhat =
      draft.trigger === "schedule" &&
      draft.action === "ask" &&
      (draft.question.trim().length < 3 || !draft.connectionId);
    return parts.map((p) => ({
      ...p,
      open:
        (p.role !== undefined && asked.has(p.role)) ||
        (p.role === "when" && openWhen) ||
        (p.role === "what" && openWhat) ||
        (p.role === "where" && noOne),
    }));
  })();

  const names: HappensNames = {
    metrics: metrics.map((m) => ({
      title: m.title,
      others: Math.max(0, m.watchedBy - (initial.metricIds.includes(m.id) && id ? 1 : 0)),
      grain: m.grain,
    })),
    line,
    source: choices.sources.find((s) => s.id === draft.connectionId)?.name ?? null,
    where: watching ? null : destinationWords({ people, channels }),
    team: needsManager({ key: watching ? "watching" : null, ownerId, userIds: draft.userIds, slack: draft.slack }),
    first:
      draft.trigger === "schedule" && next[0]
        ? `First run ${whenLine(next[0], choices.tz)}.`
        : draft.trigger === "found"
          ? "First check right after you save it, then as each period's data lands."
          : null,
  };
  const happens = draft.trigger && !problem ? whatHappens(spec as RoutineSpec, names) : null;

  const focus = (role: RoutineSentencePart["role"]) => {
    const el = (role === "when" ? when : role === "what" ? what : where).current;
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
    el?.querySelector<HTMLElement>("button:not([disabled]), input, [role=radio]")?.focus({ preventScroll: true });
  };

  const save = async () => {
    if (blocker || saving) return;
    setSaving(true);
    try {
      const out = await saveRoutineAction(id, {
        spec,
        userIds: watching ? [] : draft.userIds,
        slack: watching ? [] : draft.slack,
      });
      if (!out.ok) {
        toast.danger(out.message);
        setSaving(false);
        return;
      }
      // Busy until the routine's page opens, so a second press can't make it twice.
      toast.success(id ? "Saved." : "Routine made.");
      router.push(`/routines/${out.id}`);
    } catch {
      toast.danger("It couldn't be saved just now. Try again.");
      setSaving(false);
    }
  };

  return (
    <>
      <TopBar
        crumbs={[{ label: "Routines", href: "/routines" }, { label: id ? "Edit routine" : "New routine" }]}
        action={
          <span className="flex items-center gap-2">
            <Link
              href={id ? `/routines/${id}` : "/routines"}
              className="px-2 text-small text-muted hover:text-foreground"
            >
              Cancel
            </Link>
            <Button size="sm" isDisabled={!!blocker} isPending={saving} onPress={() => void save()}>
              <Check className="size-3.5" aria-hidden />
              Save routine
            </Button>
          </span>
        }
      />
      <div className="flex-1 overflow-y-auto px-6 pt-6 pb-16 @2xl/page:px-8">
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-1.5">
            <h1 className="text-display">{id ? "Edit routine" : "New routine"}</h1>
            <p className="max-w-reading text-body text-muted">
              Everything that runs on its own is a routine: on a schedule, or when something is found. Pick each part;
              the sentence says what you'll get.
            </p>
          </div>
          <div className="grid items-start gap-6 @4xl/page:grid-cols-3">
            <div className="flex min-w-0 flex-col gap-6 @4xl/page:col-span-2">
              {/* Describe it for a blank start; one already filled (from a metric, an answer) needs none. */}
              {id || watching || initial.trigger || !canAsk ? null : (
                <DescribeIt
                  examples={examples}
                  channels={slack.kind === "ready" ? slack.channels.filter((c) => c.member).map((c) => c.name) : []}
                  onProposal={proposed}
                  onAnswer={answered}
                  onClear={cleared}
                />
              )}
              <div className="flex flex-col gap-2 rounded-2xl bg-surface-secondary px-5 py-4">
                <span className="text-small font-medium text-muted">This routine</span>
                <RoutineSentence parts={sentence} size="lg" onPart={(_, p) => focus(p.role)} />
                {blocker && draft.trigger ? <span className="text-small text-muted">To save it: {blocker}</span> : null}
                {unplaced.length ? (
                  <span className="text-small text-warning-soft-foreground">
                    Couldn't place {unplaced.join(", ")}: pick them in Where below.
                  </span>
                ) : null}
              </div>

              <section ref={when} className="flex scroll-mt-6 flex-col gap-3">
                <SectionHead title="When" hint="What starts it" />
                <div role="radiogroup" aria-label="What starts it" className="grid gap-3 @2xl/page:grid-cols-2">
                  <TriggerCard
                    icon={CalendarClock}
                    title="On a schedule"
                    description="Every day, week or month, at a time you pick."
                    selected={draft.trigger === "schedule"}
                    disabled={(!!id && draft.trigger !== "schedule") || watching}
                    onSelect={() => set({ trigger: "schedule" })}
                  />
                  <TriggerCard
                    icon={Activity}
                    title="When something is found"
                    description="Checked as each period's data lands: unusual, crosses a line, a goal at risk, or data missing."
                    selected={draft.trigger === "found"}
                    disabled={!!id && draft.trigger !== "found"}
                    onSelect={() => set({ trigger: "found" })}
                  />
                </div>
                {id ? (
                  <p className="text-small text-muted-tertiary">
                    A routine keeps what starts it. Make a new one for the other.
                  </p>
                ) : null}
                {draft.trigger === "schedule" ? (
                  <ScheduleWhen draft={draft} set={set} tz={choices.tz} next={next} />
                ) : null}
                {draft.trigger === "found" ? (
                  <FoundWhen
                    draft={draft}
                    set={set}
                    choices={choices}
                    watching={watching}
                    savedIds={id ? initial.metricIds : []}
                  />
                ) : null}
              </section>

              {draft.trigger === "schedule" ? (
                <section ref={what} className="flex scroll-mt-6 flex-col gap-3">
                  <SectionHead title="What" hint="What it does each time" />
                  <ScheduledWhat draft={draft} set={set} choices={choices} canAsk={canAsk} />
                </section>
              ) : null}
              {draft.trigger === "found" && !watching ? (
                <section ref={what} className="flex scroll-mt-6 flex-col gap-3">
                  <SectionHead title="Tell" hint="How the news goes out" />
                  <FoundTell draft={draft} set={set} canAsk={canAsk} />
                </section>
              ) : null}

              {draft.trigger && !watching ? (
                <section ref={where} className="flex scroll-mt-6 flex-col gap-3">
                  <SectionHead title="Where" hint="Who hears about it" />
                  <Where
                    draft={draft}
                    set={set}
                    members={members}
                    me={me}
                    canManage={canManage}
                    workspace={workspace}
                    slack={slack}
                  />
                </section>
              ) : null}
              {watching ? (
                <p className="flex items-center gap-1.5 text-small text-muted">
                  <Info className="size-3.5 shrink-0" aria-hidden />
                  Watching keeps what's unusual in Insights. To tell people, make a routine of its own.
                </p>
              ) : null}
            </div>

            <aside className="flex min-w-0 flex-col gap-4 @4xl/page:sticky @4xl/page:top-0">
              <div className="flex flex-col gap-3 rounded-2xl bg-surface-secondary p-4">
                <span className="text-small font-medium text-muted">What happens</span>
                {happens ? (
                  <>
                    <ol className="flex list-decimal flex-col gap-1.5 ps-5 text-body">
                      {happens.items.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ol>
                    <p
                      className={`flex items-start gap-1.5 rounded-lg px-2.5 py-2 text-small ${
                        happens.keeps.kept ? "bg-success-soft text-success-soft-foreground" : "bg-surface text-muted"
                      }`}
                    >
                      <FileText className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                      {happens.keeps.text}
                    </p>
                    <p className="flex items-start gap-1.5 text-small text-muted">
                      <Users className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                      {happens.who}
                    </p>
                    {happens.first ? (
                      <p className="flex items-start gap-1.5 text-small text-muted">
                        <CalendarClock className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                        {happens.first}
                      </p>
                    ) : null}
                  </>
                ) : (
                  <p className="text-body text-muted">
                    As you pick each part, this says what will happen and whether it writes a report, before you save.
                  </p>
                )}
              </div>
              {fromPreset && !id ? (
                <div className="flex flex-col rounded-2xl border border-border bg-surface p-2">
                  <span className="px-2 pt-1 pb-1.5 text-small font-medium text-muted">Start from</span>
                  {PRESETS.filter((p) => canAsk || !ASKING_PRESETS.has(p.id)).map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => setDraft((d) => p.apply(d))}
                      className="flex items-center gap-3 rounded-lg px-2 py-2 text-start hover:bg-surface-secondary"
                    >
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="text-body">{p.title}</span>
                        <span className="text-small text-muted">{p.detail}</span>
                      </span>
                      <ArrowRight className="size-3.5 shrink-0 text-muted" aria-hidden />
                    </button>
                  ))}
                </div>
              ) : null}
            </aside>
          </div>
        </div>
      </div>
    </>
  );
}

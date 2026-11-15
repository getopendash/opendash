import { answerForRoutine } from "@opendash/core";
import { isUuid, withTenant } from "@opendash/db";
import type { Metadata } from "next";
import { RoutineComposer } from "@/components/routines/routine-composer";
import { emptyDraft } from "@/lib/routine-draft";
import { composerData } from "../composer-data";

export const metadata: Metadata = { title: "New routine · OpenDash" };
export const dynamic = "force-dynamic";

/**
 * A new routine: from nothing, from a metric's Set up an alert… (?metric=), or from an answer's Repeat… (?run=: its
 * question asked again on a schedule, from its source).
 */
export default async function NewRoutinePage({
  searchParams,
}: {
  searchParams: Promise<{ metric?: string; run?: string }>;
}) {
  const [{ metric, run }, data] = await Promise.all([searchParams, composerData()]);
  const me = data.actor.userId;
  let draft = emptyDraft(me);
  const fromMetric = metric && isUuid(metric) && data.choices.metrics.some((m) => m.id === metric);
  // Repeat…: only an answer the person can read, asked again each Monday at 09:00 until they pick otherwise.
  const answer =
    !fromMetric && run && isUuid(run)
      ? await withTenant({ orgId: data.actor.orgId, userId: data.actor.userId }, (tx) =>
          answerForRoutine(tx, data.actor, run),
        )
      : null;
  if (fromMetric) draft = { ...draft, trigger: "found", metricIds: [metric], condition: "crosses", tell: "at_once" };
  else if (answer) {
    draft = {
      ...draft,
      trigger: "schedule",
      repeats: "week",
      days: ["mon"],
      at: "09:00",
      action: "ask",
      question: answer.question.slice(0, 500),
      connectionId: answer.connectionId,
    };
  }
  return (
    <RoutineComposer
      // A new link (another metric's alert, another answer's Repeat…) is a new draft, not the last one's.
      key={`${metric ?? ""}:${run ?? ""}`}
      id={null}
      initial={draft}
      choices={data.choices}
      members={data.members}
      me={me}
      ownerId={me}
      canManage={data.actor.canManage}
      canAsk={data.canAsk}
      watching={false}
      workspace={data.workspace}
      fromPreset={!fromMetric && !answer}
      slack={data.slack}
    />
  );
}

import { Alert } from "@heroui/react";
import type { DraftCandidate, DraftHelper, SourceDraftState } from "@opendash/core";
import { CircleCheck, CircleMinus, CirclePause, LoaderCircle, Sparkles } from "lucide-react";
import Link from "next/link";
import { ago, count, usd } from "@/lib/format";
import { DraftPicker } from "./draft-picker";
import { BatchTraceButton, FollowBatch } from "./follow-batch";
import { RefreshWhile } from "./refresh-while";

/** What the picker needs, for owners and admins (null for others). */
export interface DraftPickerData {
  candidates: DraftCandidate[];
  suggested: number;
  max: number;
  cost: { perTableUsd: number; baseUsd: number; leftUsd: number; budgetUsd: number };
}

/**
 * A source's definitions on its Overview. With none yet, why they matter and Draft definitions (owners and
 * admins) or Write one yourself; with some, how many are verified and waiting for review, and Draft more. A draft
 * under way says so; the last one that stopped (held, or failed) says why. Drafting automatically says which
 * batch it's on and what the background budget has left; paused for the budget, what's still to draft. A batch
 * the Modeler leads lists its helpers: each group's tables and how far it got, read again as they go.
 */
export function DefinitionsPanel({
  sourceId,
  state,
  picker,
  now,
}: {
  sourceId: string;
  state: SourceDraftState;
  picker: DraftPickerData | null;
  now: number;
}) {
  const { verified, proposed } = state.definitions;
  const none = verified === 0 && proposed === 0;
  const review = state.inReview ? `/knowledge/proposals/sources/${sourceId}` : "/knowledge/proposals";
  const draftButton = (label: string, primary: boolean) =>
    picker && !state.drafting ? (
      <DraftPicker
        connectionId={sourceId}
        candidates={picker.candidates}
        suggested={picker.suggested}
        max={picker.max}
        cost={picker.cost}
        label={label}
        primary={primary}
      />
    ) : null;
  return (
    <section aria-labelledby="definitions-title" className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-4">
        <h2 id="definitions-title" className="text-body font-medium">
          Definitions
        </h2>
        <span className="text-small text-muted-tertiary">Owners and admins draft and approve</span>
      </div>
      {state.drafting && state.auto?.batch ? (
        <div className="flex items-start gap-3 rounded-2xl border border-border px-4 py-3">
          <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin text-accent" aria-hidden />
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-body font-medium">
              Drafting definitions from {count(state.drafting.tables.length, "table")} · batch {state.auto.batch} of{" "}
              {Math.max(state.auto.batch, state.auto.batches)}
            </span>
            <span className="max-w-reading text-small text-muted">
              {state.inReview ? (
                <>
                  <Link href={review} className="text-link hover:underline">
                    {count(state.inReview, "draft")}
                  </Link>{" "}
                  from earlier batches {state.inReview === 1 ? "is" : "are"} waiting for your review.{" "}
                </>
              ) : null}
              Each batch is drafted from the tables you chose, most useful first, and waits in Proposals; nothing
              answers until you approve it.
            </span>
            <span className="text-small text-muted-tertiary">
              From the background budget: {usd(state.auto.budget.budgetUsd)} a month, {usd(state.auto.budget.leftUsd)}{" "}
              left.
            </span>
            <DraftingProgress drafting={state.drafting} now={now} canTrace={picker !== null} />
          </div>
        </div>
      ) : state.auto?.held ? (
        <div className="flex items-start gap-3 rounded-2xl border border-border px-4 py-3">
          <CirclePause className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-body font-medium">Drafting is paused for the background budget</span>
            <span className="max-w-reading text-small text-muted">
              {state.auto.held.reason} {count(state.auto.toDraft, "of the tables you chose", "of the tables you chose")}{" "}
              {state.auto.toDraft === 1 ? "is" : "are"} still to draft; OpenDash resumes on its own when there's budget
              again.
            </span>
            {state.inReview ? (
              <Link href={review} className="text-small text-link hover:underline">
                {count(state.inReview, "draft")} from earlier batches {state.inReview === 1 ? "is" : "are"} waiting for
                your review
              </Link>
            ) : null}
          </div>
        </div>
      ) : state.drafting ? (
        <div className="flex items-start gap-3 rounded-2xl border border-border px-4 py-3">
          <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin text-accent" aria-hidden />
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-body font-medium">
              OpenDash is drafting definitions from {count(state.drafting.tables.length, "table")}
            </span>
            <span className="text-small text-muted">
              {state.drafting.helpers.length ? (
                "Helpers draft them three at a time, each table tested against your data"
              ) : (
                <>
                  <span className="font-mono">{state.drafting.tables.join(", ")}</span> · started{" "}
                  {ago(state.drafting.startedAt, now)}. Each draft is tested against your data
                </>
              )}
              . Each draft then waits in{" "}
              <Link href="/knowledge/proposals" className="text-link hover:underline">
                Knowledge → Proposals
              </Link>{" "}
              for review.
            </span>
            <DraftingProgress drafting={state.drafting} now={now} canTrace={picker !== null} />
          </div>
        </div>
      ) : none ? (
        <div className="flex items-start gap-3 rounded-2xl border border-border px-4 py-3.5">
          <Sparkles className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-body font-medium">No datasets or metrics yet</span>
            <p className="max-w-reading text-small text-muted">
              Questions are answered from the tables directly, as Unmodelled. With definitions, answers use your team's
              meaning of each number, and dashboards, routines and insights work on this source.
            </p>
            {picker ? (
              <p className="max-w-reading text-small text-muted-tertiary">
                OpenDash drafts them from the tables you pick: a dataset for each and a few metrics, each tested against
                your data. Nothing answers until you approve it.
              </p>
            ) : null}
            <div className="mt-1.5 flex flex-wrap items-center gap-3">
              {draftButton("Draft definitions", true)}
              {picker ? (
                <Link href={`/knowledge/datasets/new?source=${sourceId}`} className="text-body hover:underline">
                  Write one yourself
                </Link>
              ) : (
                <span className="text-small text-muted-tertiary">An owner or admin drafts them.</span>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border px-4 py-3">
          <span className="text-body">
            {count(verified, "definition")} verified
            {proposed ? (
              <>
                {" · "}
                <Link href={review} className="text-link hover:underline">
                  {proposed} waiting for review
                </Link>
              </>
            ) : null}
          </span>
          {draftButton("Draft more", false)}
        </div>
      )}
      {state.stopped && !state.drafting && !state.auto?.held ? (
        <Alert status={state.stopped.status === "held" ? "warning" : "danger"}>
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>
              {state.stopped.status === "held" ? "The last draft is held" : "The last draft stopped"}
            </Alert.Title>
            <Alert.Description>{state.stopped.reason}</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
    </section>
  );
}

/**
 * A batch under way, automatic or asked for: its helpers when the Modeler leads it, and the page read again every
 * few seconds while it drafts.
 */
function DraftingProgress({
  drafting,
  now,
  canTrace,
}: {
  drafting: NonNullable<SourceDraftState["drafting"]>;
  now: number;
  /** Owners and admins (who draft): the batch's trace is theirs to open. */
  canTrace: boolean;
}) {
  return (
    <>
      {drafting.helpers.length ? <Helpers helpers={drafting.helpers} now={now} /> : null}
      {drafting.leads && drafting.runId && canTrace ? (
        <span className="flex justify-end pt-1">
          <BatchTraceButton runId={drafting.runId} />
        </span>
      ) : null}
      {drafting.leads ? (
        drafting.runId ? (
          <FollowBatch runId={drafting.runId} />
        ) : (
          <RefreshWhile everyMs={10_000} />
        )
      ) : null}
    </>
  );
}

/** Each helper's tables, and where it got. */
function Helpers({ helpers, now }: { helpers: DraftHelper[]; now: number }) {
  const said = (h: DraftHelper) => {
    if (h.state === "drafting") return `drafting · ${ago(h.startedAt, now).replace(/ ago$/, "")}`;
    if (h.state === "kept") {
      return [h.datasets ? count(h.datasets, "dataset") : null, h.metrics ? count(h.metrics, "metric") : null]
        .filter(Boolean)
        .join(", ")
        .concat(" kept");
    }
    return h.state === "left_out"
      ? `left out${h.reason ? `: ${h.reason}` : ""}`
      : `stopped${h.reason ? `: ${h.reason}` : ""}`;
  };
  return (
    <ul className="mt-1.5 flex flex-col">
      {helpers.map((h) => (
        <li key={h.tables.join(",")} className="flex items-center gap-2 border-separator border-t py-1.5 text-small">
          {h.state === "drafting" ? (
            <LoaderCircle className="size-3.5 shrink-0 animate-spin text-accent" aria-hidden />
          ) : h.state === "kept" ? (
            <CircleCheck className="size-3.5 shrink-0 text-success" aria-hidden />
          ) : (
            <CircleMinus className="size-3.5 shrink-0 text-muted-tertiary" aria-hidden />
          )}
          <span className="min-w-0 truncate font-mono text-foreground">{h.tables.join(", ")}</span>
          <span className="ms-auto shrink-0 text-muted">{said(h)}</span>
        </li>
      ))}
    </ul>
  );
}

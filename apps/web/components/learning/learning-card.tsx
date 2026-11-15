"use client";

import { Button, Input, Label, TextField, toast } from "@heroui/react";
import type { LearningCard as Learning } from "@opendash/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, CheckCircle2, ChevronRight, CircleSlash, Lightbulb, LoaderCircle } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiQueries } from "@/lib/api";

/** Still being worked on: the card is read again until it settles. */
const WORKING = new Set(["drafting", "held", "evaluating"]);

/** What a learning says, in a line: the word, where it lives, and what it is not. */
function meaning(l: Learning): string {
  const where = l.column ? l.column.split(".").slice(-2) : null;
  const is = where ? `${where[0]}${l.values.length ? ` where ${where[1]} = ${l.values.join(", ")}` : ""}` : l.means;
  const not = l.not.length ? `; not ${l.not.map((t) => t.split(".").at(-1)).join(", ")}` : "";
  return `${l.term ?? "This"} means ${is}${not}`;
}

/** How it was checked and tested, in a line, with why when it didn't pass. */
function checked(l: Learning): string {
  const said = `Said ${l.said.length === 1 ? "once" : `${l.said.length} times`}${l.people > 1 ? ` by ${l.people} people` : ""}`;
  const check = l.check
    ? l.check.ok
      ? "check passed"
      : `check didn't pass${l.check.why ? `: ${l.check.why}` : ""}`
    : null;
  const test = l.test
    ? l.test.ok && l.test.used
      ? "test passed"
      : l.test.ok === null
        ? "testing"
        : `test didn't pass${l.test.why ? `: ${l.test.why}` : ""}`
    : null;
  return [said, check, test].filter(Boolean).join(" · ");
}

/**
 * The learning card, under the answer where a correction was given: OpenDash learning it for the team (checking, testing),
 * then "Make this a team learning?" for an owner or admin (one tap), "Suggested to your admins" for whoever corrected
 * it, "OpenDash learned for the team · Revert" when the rule released it, or why it wasn't learned.
 */
export function LearningCards({ runId, corrected }: { runId: string; corrected: boolean }) {
  const queryClient = useQueryClient();
  // A thumbs down's correction opens one too: the feedback the buttons already read says so.
  const mine = useQuery(apiQueries.feedback.mine.queryOptions({ input: { runId } }));
  const enabled = corrected || Boolean(mine.data?.answer?.correction?.learningId);
  const list = useQuery({
    ...apiQueries.learning.forRun.queryOptions({ input: { runId } }),
    enabled,
    refetchInterval: (q) => (q.state.data?.some((l) => WORKING.has(l.status)) ? 4000 : false),
  });
  if (!enabled || !list.data?.length) return null;
  return (
    <div className="flex flex-col gap-2">
      {list.data.map((l) => (
        <LearningCard
          key={l.id}
          learning={l}
          onChanged={() => queryClient.invalidateQueries(apiQueries.learning.forRun.queryOptions({ input: { runId } }))}
        />
      ))}
    </div>
  );
}

/**
 * Knowledge → Proposals (owners and admins): the workspace's learnings, waiting first, each the same card with what
 * the corrections said.
 */
export function LearningsReview() {
  const queryClient = useQueryClient();
  const list = useQuery({
    ...apiQueries.learning.list.queryOptions(),
    refetchInterval: (q) => (q.state.data?.some((l) => WORKING.has(l.status)) ? 5000 : false),
  });
  if (!list.data?.length) return null;
  return (
    <section className="flex flex-col gap-3" aria-label="Learnings">
      <div className="flex flex-col gap-1">
        <span className="flex items-baseline justify-between gap-3">
          <h2 className="text-title">Learnings</h2>
          <Link href="/knowledge/learnings" className="flex items-center gap-1 text-small text-link hover:underline">
            All learnings
            <ArrowRight className="size-3" aria-hidden />
          </Link>
        </span>
        <p className="max-w-reading text-small text-muted">
          What your team corrected, as terms the analyst will use: checked on your data and tested before they're
          offered. Make one the team's, or let the rule do it when it's safe.
        </p>
      </div>
      {list.data.map((l) => (
        <LearningCard
          key={l.id}
          learning={l}
          showSaid
          onChanged={() => queryClient.invalidateQueries(apiQueries.learning.list.queryOptions())}
        />
      ))}
    </section>
  );
}

/** A topic's learnings on its page (Knowledge → Learnings): the same cards, the page read again after a tap. */
export function TopicCards({ cards }: { cards: Learning[] }) {
  const router = useRouter();
  return (
    <div className="flex flex-col gap-2">
      {cards.map((l) => (
        <LearningCard key={l.id} learning={l} showSaid inTopic onChanged={() => router.refresh()} />
      ))}
    </div>
  );
}

/** What the corrections said, folded inside the card: the latest three, each with its day. */
function Said({ said }: { said: Learning["said"] }) {
  if (!said.length) return null;
  return (
    <details className="group flex flex-col gap-1.5">
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-small text-muted hover:text-foreground">
        <ChevronRight className="size-3 transition-transform group-open:rotate-90" aria-hidden />
        What was said
        <span className="text-muted-tertiary">{said.length}</span>
      </summary>
      <ul className="mt-1.5 flex flex-col gap-1 border-border border-l pl-3 text-small text-muted">
        {said.slice(-3).map((s) => (
          <li key={`${s.at}-${s.text}`}>
            “{s.text.replace(/^["“”']+|["“”']+$/g, "")}” ·{" "}
            <span className="text-muted-tertiary">
              {new Date(s.at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function LearningCard({
  learning: l,
  onChanged,
  showSaid = false,
  inTopic = false,
}: {
  learning: Learning;
  onChanged: () => void;
  /** Knowledge → Proposals: what its corrections said, folded inside the card. */
  showSaid?: boolean;
  /** On its topic's own page: no link back to it. */
  inTopic?: boolean;
}) {
  const refresh = onChanged;
  const failed = (error: Error) => toast.danger(error.message);
  const approve = useMutation(apiQueries.learning.approve.mutationOptions({ onSuccess: refresh, onError: failed }));
  const revert = useMutation(apiQueries.learning.revert.mutationOptions({ onSuccess: refresh, onError: failed }));
  const reject = useMutation(apiQueries.learning.reject.mutationOptions({ onSuccess: refresh, onError: failed }));
  const [editing, setEditing] = useState(false);

  if (WORKING.has(l.status)) {
    const doing =
      l.status === "held"
        ? `Waiting to learn this for the team: ${l.heldReason ?? "background work is paused"}`
        : l.status === "drafting"
          ? "OpenDash is looking into this as a learning for the team…"
          : l.check?.ok
            ? `Check passed · testing it: ${meaning(l)}`
            : `Checking it on the data: ${meaning(l)}`;
    return (
      <Quiet
        icon={
          <LoaderCircle
            className={`size-3.5 shrink-0 text-muted ${l.status === "held" ? "" : "animate-spin"}`}
            aria-hidden
          />
        }
      >
        {doing}
      </Quiet>
    );
  }
  if (l.status === "open" && l.canApprove) {
    return (
      <section className="flex flex-col gap-2 rounded-xl border border-border p-3" aria-label="A learning for the team">
        <span className="flex items-center gap-2 text-body font-medium">
          <Lightbulb className="size-4 text-accent" aria-hidden />
          Make this a team learning?
        </span>
        <p className="text-body">{meaning(l)}.</p>
        {l.synonyms.length ? <p className="text-small text-muted">Also called: {l.synonyms.join(" · ")}</p> : null}
        <p className="text-small text-muted">
          {checked(l)}
          {l.edited ? " · changed before the tap" : ""}
        </p>
        {showSaid ? <Said said={l.said} /> : null}
        {editing ? (
          <EditLearning
            learning={l}
            onDone={() => {
              setEditing(false);
              refresh();
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <span className="flex flex-wrap items-center gap-1.5">
            <Button size="sm" isPending={approve.isPending} onPress={() => approve.mutate({ id: l.id })}>
              Make it a team learning
            </Button>
            <Button size="sm" variant="ghost" onPress={() => setEditing(true)}>
              Edit
            </Button>
            <Button size="sm" variant="ghost" isPending={reject.isPending} onPress={() => reject.mutate({ id: l.id })}>
              Not this
            </Button>
            {l.topic && !inTopic ? (
              <Link
                href={`/knowledge/learnings/${l.topic}`}
                className="ml-auto flex items-center gap-1 text-small text-link hover:underline"
              >
                Its topic
                <ArrowRight className="size-3" aria-hidden />
              </Link>
            ) : null}
          </span>
        )}
      </section>
    );
  }
  if (l.status === "open") {
    return (
      <Quiet icon={<Lightbulb className="size-3.5 shrink-0 text-accent" aria-hidden />}>
        Suggested to your admins: {meaning(l)}.
      </Quiet>
    );
  }
  if (l.status === "approved") {
    return (
      <Quiet
        icon={<CheckCircle2 className="size-3.5 shrink-0 text-success" aria-hidden />}
        action={
          l.canApprove ? (
            <Button size="sm" variant="ghost" isPending={revert.isPending} onPress={() => revert.mutate({ id: l.id })}>
              Revert
            </Button>
          ) : null
        }
      >
        {l.automatic ? "OpenDash learned for the team" : "A team learning now"}: {meaning(l)}.
      </Quiet>
    );
  }
  const why =
    l.status === "reverted"
      ? "Reverted: the team no longer uses this learning."
      : l.status === "rejected"
        ? `Not made a team learning${l.note ? `: ${l.note}` : "."}`
        : l.status === "discarded"
          ? `Nothing to learn for the team here${l.note ? `: ${l.note}` : "."}`
          : `It couldn't be learned${l.note ? `: ${l.note}` : "."}`;
  return <Quiet icon={<CircleSlash className="size-3.5 shrink-0 text-muted" aria-hidden />}>{why}</Quiet>;
}

/** A comma list as the form shows it, and back. */
const joined = (xs: string[]) => xs.join(", ");
const split = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

/**
 * An admin's change before the tap: what it means, where it lives, what else it's called and what it isn't. Saved, it's
 * checked and tested again, then waits for their tap (the rule never releases a changed one).
 */
function EditLearning({
  learning: l,
  onDone,
  onCancel,
}: {
  learning: Learning;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [means, setMeans] = useState(l.means ?? "");
  const [column, setColumn] = useState(l.column ?? "");
  const [values, setValues] = useState(joined(l.values));
  const [synonyms, setSynonyms] = useState(joined(l.synonyms));
  const [not, setNot] = useState(joined(l.not));
  const edit = useMutation(
    apiQueries.learning.edit.mutationOptions({ onSuccess: onDone, onError: (e: Error) => toast.danger(e.message) }),
  );
  const save = () =>
    edit.mutate({
      id: l.id,
      ...(means.trim() ? { means: means.trim() } : {}),
      column: column.trim() || null,
      values: split(values),
      synonyms: split(synonyms),
      not: split(not),
    });
  return (
    <form
      className="flex flex-col gap-2.5 border-border border-t pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <TextField value={means} onChange={setMeans} className="flex flex-col gap-1">
        <Label className="text-small">What it means</Label>
        <Input />
      </TextField>
      <div className="grid gap-2.5 @lg/page:grid-cols-2">
        <TextField value={column} onChange={setColumn} className="flex min-w-0 flex-col gap-1">
          <Label className="text-small">Column</Label>
          <Input placeholder="schema.table.column" className="font-mono" />
        </TextField>
        <TextField value={values} onChange={setValues} className="flex min-w-0 flex-col gap-1">
          <Label className="text-small">Values it means</Label>
          <Input placeholder="active" />
        </TextField>
      </div>
      <TextField value={synonyms} onChange={setSynonyms} className="flex flex-col gap-1">
        <Label className="text-small">Also called</Label>
        <Input placeholder="Only words for exactly this, separated by commas" />
      </TextField>
      <TextField value={not} onChange={setNot} className="flex flex-col gap-1">
        <Label className="text-small">Not the same as</Label>
        <Input placeholder="schema.table, separated by commas" className="font-mono" />
      </TextField>
      <p className="text-small text-muted-tertiary">
        Saved, it's checked on the data and tested again, then waits for your tap.
      </p>
      <span className="flex flex-wrap items-center gap-1.5">
        <Button size="sm" type="submit" isPending={edit.isPending}>
          Save and check again
        </Button>
        <Button size="sm" variant="ghost" onPress={onCancel}>
          Cancel
        </Button>
      </span>
    </form>
  );
}

function Quiet({
  icon,
  action,
  children,
}: {
  icon: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 rounded-xl bg-surface-secondary px-3 py-2 text-small">
      {icon}
      <span className="flex-1 text-muted">{children}</span>
      {action}
    </div>
  );
}

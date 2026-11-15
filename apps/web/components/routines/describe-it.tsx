"use client";

import { Button, Spinner } from "@heroui/react";
import type { ComposerOutcome, ComposerPart, ComposerPatch } from "@opendash/core";
import { CircleCheck, CornerDownRight, MessageCircleQuestion, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { describeResultAction, describeRoutineAction } from "@/app/(app)/routines/describe-actions";

/** How long to wait for the composer before saying so. */
const WAIT_MS = 90_000;

/**
 * Describe it: the routine in plain words. The composer fills in what it can tell, and
 * asks back, as choices, what it can't; picking one fills that part. Nothing is saved until the person saves.
 */
export function DescribeIt({
  examples,
  channels,
  onProposal,
  onAnswer,
  onClear,
}: {
  examples: string[];
  /** The channels the composer listed, for the composer agent to name (owners and admins). */
  channels: string[];
  onProposal: (outcome: ComposerOutcome) => void;
  /** A question answered: its part, and what the choice sets. */
  onAnswer: (part: ComposerPart, patch: ComposerPatch, settled: boolean) => void;
  onClear: () => void;
}) {
  const [text, setText] = useState("");
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "working" }
    | { kind: "done"; outcome: ComposerOutcome }
    | { kind: "failed"; message: string }
  >({ kind: "idle" });
  const [chosen, setChosen] = useState<Record<number, number>>({});
  // Mounted, for the poll to know it may still say something. Set in the effect too: React mounts twice in dev.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const fillIn = async (words = text) => {
    if (words.trim().length < 3 || state.kind === "working") return;
    setText(words);
    setState({ kind: "working" });
    setChosen({});
    try {
      const started = await describeRoutineAction(words, channels);
      if (!started.ok) {
        setState({ kind: "failed", message: started.message });
        return;
      }
      const since = Date.now();
      while (alive.current && Date.now() - since < WAIT_MS) {
        await new Promise((r) => setTimeout(r, 1000));
        const read = await describeResultAction(started.runId);
        if (read.status === "working") continue;
        if (read.status === "failed") {
          setState({ kind: "failed", message: read.message });
          return;
        }
        setState({ kind: "done", outcome: read.outcome });
        onProposal(read.outcome);
        return;
      }
      if (alive.current)
        setState({ kind: "failed", message: "It's taking too long. Try again, or pick each part below." });
    } catch {
      // The server didn't answer (a deploy, the network): never left spinning.
      if (alive.current)
        setState({ kind: "failed", message: "OpenDash couldn't be reached. Try again, or pick each part below." });
    }
  };

  const clear = () => {
    setText("");
    setState({ kind: "idle" });
    setChosen({});
    onClear();
  };

  const outcome = state.kind === "done" ? state.outcome : null;
  const questions = outcome?.questions ?? [];
  const answer = (qi: number, oi: number) => {
    const q = questions[qi];
    const o = q?.options[oi];
    if (!q || !o) return;
    const next = { ...chosen, [qi]: oi };
    setChosen(next);
    // Its part is settled once every question about it is answered.
    const settled = questions.every((x, i) => x.part !== q.part || next[i] !== undefined);
    onAnswer(q.part, o.patch, settled);
  };

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-accent bg-surface px-4 py-3">
      <div className="flex items-center gap-2">
        <Sparkles className="size-4 shrink-0 text-accent" aria-hidden />
        <span className="text-body font-medium">Describe it</span>
        <span className="min-w-0 flex-1 truncate text-small text-muted">
          Plain words. OpenDash fills in the routine below.
        </span>
        <kbd className="hidden shrink-0 rounded border border-border px-1 text-micro text-muted @xl/page:inline">
          ⌘↵
        </kbd>
      </div>
      <textarea
        aria-label="Describe the routine"
        value={text}
        rows={2}
        maxLength={500}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void fillIn();
          }
        }}
        placeholder="Say what should happen, and when…"
        className="w-full resize-none bg-transparent text-body outline-none placeholder:text-muted-tertiary"
      />
      {state.kind === "idle" && examples.length ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-small text-muted">For example</span>
          <div className="grid gap-1.5 @2xl/page:grid-cols-2">
            {examples.map((x) => (
              <button
                key={x}
                type="button"
                onClick={() => void fillIn(x)}
                className="flex items-start gap-2 rounded-lg bg-surface-secondary px-2.5 py-1.5 text-start text-small text-muted hover:text-foreground"
              >
                <CornerDownRight className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                {x}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {state.kind === "working" ? (
        <span className="flex items-center gap-2 text-small text-muted" role="status">
          <Spinner size="sm" />
          Working out the routine…
        </span>
      ) : null}
      {state.kind === "failed" ? (
        <span className="text-small text-danger" role="alert">
          {state.message}
        </span>
      ) : null}
      {outcome ? (
        <div className="flex flex-col gap-3">
          {questions.length ? (
            <div className="flex flex-col gap-2.5 rounded-xl bg-surface-secondary px-3 py-2.5">
              <span className="flex items-center gap-1.5 text-body font-medium">
                <MessageCircleQuestion className="size-4 shrink-0 text-muted" aria-hidden />
                {questions.length === 1
                  ? "One thing OpenDash can't tell from your words"
                  : `${questions.length === 2 ? "Two" : "Three"} things OpenDash can't tell from your words`}
              </span>
              {questions.map((q, qi) => (
                <div key={`${q.part}-${q.ask}`} className="flex flex-col gap-1.5">
                  <span className="text-small text-muted">{q.ask}</span>
                  <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={q.ask}>
                    {q.options.map((o, oi) => (
                      // biome-ignore lint/a11y/useSemanticElements: a chip-sized choice; ARIA says what it is
                      <button
                        key={o.label}
                        type="button"
                        role="radio"
                        aria-checked={chosen[qi] === oi}
                        onClick={() => answer(qi, oi)}
                        className={`rounded-lg border px-2.5 py-1 text-small ${
                          chosen[qi] === oi
                            ? "border-accent bg-accent-soft font-medium text-accent-soft-foreground"
                            : "border-border bg-surface hover:bg-surface-secondary"
                        }`}
                      >
                        {o.label}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              <span className="text-small text-muted-tertiary">
                It only asks what it can't work out. Everything else is filled in below.
              </span>
            </div>
          ) : null}
          <div className="flex items-start justify-between gap-3">
            <span className="flex items-start gap-1.5 text-small text-muted">
              <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden />
              Understood. {outcome.understood} Check the routine before you save it.
            </span>
            <Button size="sm" variant="ghost" onPress={clear}>
              <X className="size-3.5" aria-hidden />
              Clear
            </Button>
          </div>
        </div>
      ) : null}
      {state.kind !== "working" ? (
        <div className="flex justify-end">
          <Button size="sm" variant="outline" isDisabled={text.trim().length < 3} onPress={() => void fillIn()}>
            <Sparkles className="size-3.5" aria-hidden />
            Fill it in
          </Button>
        </div>
      ) : null}
    </div>
  );
}

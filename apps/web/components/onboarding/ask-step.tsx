"use client";

import { Alert, Button, buttonVariants, Spinner } from "@heroui/react";
import { Pair } from "@opendash/ui";
import { ArrowRight, ArrowUp, CircleCheck } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";
import { sampleDataProgress } from "@/app/(onboarding)/get-started/actions";
import { useStartThread } from "@/components/ask/use-start-thread";
import type { OnboardingSource } from "@/lib/onboarding";
import { StepSheet } from "./onboarding-shell";

const POLL_MS = 2_000;

/**
 * The last step: a first question. A few to pick from (about the sample data's own tables, or openers that work on
 * any database), or one typed. While the source is still being learned it says so and waits; with no source or no
 * model yet it says what's missing and where to add it, and OpenDash can be opened either way.
 */
export function AskStep({
  source,
  modelReady,
  questions,
}: {
  source: OnboardingSource | null;
  modelReady: boolean;
  questions: { topic: string; question: string }[];
}) {
  const router = useRouter();
  const { start, pending, error } = useStartThread();
  const [text, setText] = useState("");
  const [asking, setAsking] = useState<string | null>(null);
  const waiting = Boolean(source) && !source?.ready && !source?.failed;

  // Still being learned: followed until it's ready. The sample data's tables are chosen on the way, if they weren't.
  useEffect(() => {
    if (!source || !waiting) return;
    let stopped = false;
    const timer = setInterval(async () => {
      if (source.sample) await sampleDataProgress(source.id).catch(() => null);
      if (!stopped) router.refresh();
    }, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [source, waiting, router]);

  const canAsk = Boolean(source?.ready) && modelReady && !pending;
  const ask = (question: string) => {
    if (!source || !canAsk || !question.trim()) return;
    setAsking(question);
    start(source.id, question.trim());
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    ask(text);
  };

  const missing = !source ? (
    <>
      There's no data to ask about yet.{" "}
      <Link href="/get-started/data" className="text-link hover:underline">
        Connect a source
      </Link>
      , or use the sample data.
    </>
  ) : !modelReady ? (
    <>
      There's no model to answer yet.{" "}
      <Link href="/get-started/ai" className="text-link hover:underline">
        Add a provider's key
      </Link>{" "}
      first.
    </>
  ) : source.failed ? (
    <>
      {source.name} couldn't be learned.{" "}
      <Link href={`/data/sources/${source.id}`} className="text-link hover:underline">
        See what happened
      </Link>
    </>
  ) : null;

  return (
    <StepSheet
      wide
      pair={<Pair size={64} state={pending ? "thinking" : waiting ? "working" : canAsk ? "listening" : "idle"} />}
      title="Ask your first question"
      lead={
        source?.ready
          ? `Pick one about ${source.name}, or ask your own. You'll see the answer, the queries behind it, and what was checked.`
          : "Pick a question, or ask your own. You'll see the answer, the queries behind it, and what was checked."
      }
      footer={
        <>
          <Link href="/get-started/ai" className={buttonVariants({ variant: "ghost" })}>
            Back
          </Link>
          <span className="flex-1" />
          <Link href="/" className={`${buttonVariants({ variant: canAsk ? "ghost" : "primary" })} gap-1.5`}>
            {canAsk ? "I'll explore on my own" : "Open OpenDash"}
            <ArrowRight className="size-4" aria-hidden />
          </Link>
        </>
      }
    >
      {waiting && source ? (
        <p aria-live="polite" className="flex items-center gap-2.5 rounded-2xl bg-accent-soft px-4 py-3 text-body">
          <Spinner size="sm" aria-hidden />
          <span className="text-accent-soft-foreground">
            Learning {source.name}: reading its tables and what's in them. Usually under a minute.
          </span>
        </p>
      ) : source?.ready && modelReady ? (
        <p className="flex items-center gap-2 text-small text-muted">
          <CircleCheck className="size-3.5 text-success" aria-hidden />
          {source.name} is learned, and a model is ready.
        </p>
      ) : null}
      {missing ? (
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{missing}</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
      {error ? (
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{error}</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
      <ul className="grid gap-2.5 md:grid-cols-2">
        {questions.map((q) => (
          <li key={q.question} className="blueprint-block flex">
            <button
              type="button"
              disabled={!canAsk}
              onClick={() => ask(q.question)}
              className="group flex w-full flex-col gap-1.5 rounded-2xl border border-border px-4 py-3 text-start enabled:hover:border-accent enabled:hover:bg-accent-soft disabled:opacity-60"
            >
              <span className="text-micro font-medium tracking-wide text-muted-tertiary uppercase">{q.topic}</span>
              <span className="flex-1 text-body">{q.question}</span>
              <span className="flex items-center gap-1 text-small font-medium text-link">
                {asking === q.question && pending ? (
                  <>
                    <Spinner size="sm" aria-hidden />
                    Asking…
                  </>
                ) : (
                  <>
                    Ask this
                    <ArrowRight className="size-3.5" aria-hidden />
                  </>
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <form
        onSubmit={submit}
        className="flex items-center gap-2 rounded-2xl border border-border py-1.5 ps-4 pe-1.5 focus-within:border-accent"
      >
        <input
          aria-label="Your question"
          value={text}
          onChange={(event) => setText(event.target.value)}
          disabled={!canAsk}
          placeholder={source ? `Ask anything about ${source.name}…` : "Ask anything about your data…"}
          className="h-9 min-w-0 flex-1 bg-transparent text-body outline-none placeholder:text-muted-tertiary"
        />
        <Button type="submit" isIconOnly aria-label="Send" isDisabled={!canAsk || !text.trim()} isPending={pending}>
          <ArrowUp className="size-4" aria-hidden />
        </Button>
      </form>
    </StepSheet>
  );
}

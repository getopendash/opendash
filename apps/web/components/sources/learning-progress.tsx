"use client";

import { Alert, Button, buttonVariants } from "@heroui/react";
import type { SyncRunView } from "@opendash/core";
import { Pair } from "@opendash/ui";
import { ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { syncSource } from "@/app/(app)/data/sources/actions";
import { count } from "@/lib/format";
import { CheckRow } from "./check-row";

const POLL_MS = 1_000;
const FINISHED = new Set(["succeeded", "failed"]);

/**
 * "Getting to know …": the three learning steps as the worker writes them, polled from the run. When the run
 * ends the page is refreshed, so the server renders the source in its new state.
 */
export function LearningProgress({
  sourceId,
  name,
  initial,
  firstTime,
  canRetry,
  queuedWarningMs,
}: {
  sourceId: string;
  name: string;
  initial: SyncRunView;
  firstTime: boolean;
  canRetry: boolean;
  queuedWarningMs: number;
}) {
  const router = useRouter();
  const [run, setRun] = useState(initial);
  const [slowWorker, setSlowWorker] = useState(false);
  const [retrying, startRetry] = useTransition();
  const [retryError, setRetryError] = useState<string | null>(null);

  useEffect(() => {
    if (FINISHED.has(initial.status)) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const response = await fetch(`/api/sync-runs/${initial.id}`, { cache: "no-store" });
        if (response.ok) {
          const next = (await response.json()) as SyncRunView;
          if (stopped) return;
          setRun(next);
          setSlowWorker(next.status === "queued" && Date.now() - Date.parse(next.createdAt) > queuedWarningMs);
          if (FINISHED.has(next.status)) {
            router.refresh();
            return;
          }
        }
      } catch {
        // A dropped request is retried on the next tick.
      }
      if (!stopped) timer = setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [initial.id, initial.status, queuedWarningMs, router]);

  const failed = run.status === "failed";
  const personal = run.facts.personalData ?? 0;
  return (
    <section aria-label={`Learning ${name}`} className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-3">
          {/* Pair: at work while it learns; done, it's still; when it stops, it needs someone. */}
          <Pair
            size={36}
            state={failed ? "attention" : run.status === "succeeded" ? "success" : "working"}
            still={FINISHED.has(run.status)}
          />
          <h2 className="text-title">
            {failed
              ? firstTime
                ? `Couldn't finish learning ${name}`
                : "The last sync failed"
              : firstTime
                ? `Getting to know ${name}`
                : `Syncing ${name}`}
          </h2>
        </div>
        <p className="text-body text-muted">
          {failed
            ? `OpenDash stopped at the step below.${firstTime ? "" : " What it learned before still applies."} Fix what it says, then try again.`
            : "OpenDash is reading your schema and profiling the tables it learns. This usually takes a few minutes."}
        </p>
      </div>
      <ul className="flex flex-col">
        {run.steps.map((step) => (
          <CheckRow key={step.key} check={step} />
        ))}
      </ul>
      {slowWorker ? (
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>
              No worker has picked this up yet. Make sure the OpenDash worker is running.
            </Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
      {personal > 0 ? (
        <div className="flex gap-2.5 rounded-2xl bg-accent-soft px-3 py-2.5">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-accent-soft-foreground" aria-hidden />
          <div className="flex flex-col gap-0.5">
            <p className="text-body font-medium text-accent-soft-foreground">
              {count(personal, "column")} {personal === 1 ? "looks" : "look"} like personal data
            </p>
            <p className="text-body text-muted">
              Emails, names and phone numbers are kept out of samples and never shown to the model. OpenDash keeps what
              it learns about your data, not the data: values are read from the source when a question needs one.
            </p>
          </div>
        </div>
      ) : null}
      {failed ? (
        canRetry ? (
          <div className="flex items-center gap-3">
            <Button
              isPending={retrying}
              onPress={() =>
                startRetry(async () => {
                  setRetryError(null);
                  const result = await syncSource(sourceId);
                  if (result?.message) setRetryError(result.message);
                })
              }
            >
              Try again
            </Button>
            <Link href={`/data/sources/${sourceId}/reconnect`} className={buttonVariants({ variant: "ghost" })}>
              Update credentials
            </Link>
            {retryError ? <span className="text-small text-danger">{retryError}</span> : null}
          </div>
        ) : (
          <p className="text-small text-muted">An owner or admin can try again.</p>
        )
      ) : (
        <p className="text-small text-muted-tertiary">Keep using OpenDash meanwhile; this page updates by itself.</p>
      )}
    </section>
  );
}

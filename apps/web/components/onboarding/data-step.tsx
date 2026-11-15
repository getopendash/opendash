"use client";

import { Alert, Button, buttonVariants, Chip, Spinner } from "@heroui/react";
import { ClickHouseLogo, MySqlLogo, Pair, type PairState, PostgresLogo } from "@opendash/ui";
import { ArrowRight, CircleCheck, Lock } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  connectSampleData,
  type SampleDataProgress,
  sampleDataProgress,
  startSampleData,
} from "@/app/(onboarding)/get-started/actions";
import { CheckRow } from "@/components/sources/check-row";
import { useConnectionTest } from "@/components/sources/use-connection-test";
import type { OnboardingSource } from "@/lib/onboarding";
import { StepSheet } from "./onboarding-shell";

const DATASETS = ["UK house prices", "Hacker News", "Flights", "COVID-19"];
const OWN = [
  { kind: "postgres", label: "PostgreSQL", Logo: PostgresLogo },
  { kind: "mysql", label: "MySQL", Logo: MySqlLogo },
  { kind: "clickhouse", label: "ClickHouse", Logo: ClickHouseLogo },
] as const;
const POLL_MS = 1_000;

/** A line of the sample data's progress after its check: reading its tables, learning the chosen ones. */
function Line({ state, children, detail }: { state: "todo" | "doing" | "done"; children: string; detail?: string }) {
  return (
    <li className="flex items-start gap-2.5 py-1.75">
      <span className="flex h-5 shrink-0 items-center">
        {state === "doing" ? (
          <Spinner size="sm" aria-hidden />
        ) : (
          <CircleCheck className={`size-4 ${state === "done" ? "text-success" : "text-muted-tertiary"}`} aria-hidden />
        )}
      </span>
      <span className={`flex-1 text-body ${state === "todo" ? "text-muted" : "text-foreground"}`}>{children}</span>
      {detail ? <span className="shrink-0 text-small leading-5 text-muted-tertiary">{detail}</span> : null}
    </li>
  );
}

/**
 * The Data step: the sample data in one press (checked, connected and its best tables chosen, each step shown as it
 * happens), or the person's own database through the same form the app uses. A source that's there already is said
 * so, and the step is done.
 */
export function DataStep({
  source,
  canSetUp,
  queuedWarningMs,
}: {
  source: OnboardingSource | null;
  canSetUp: boolean;
  queuedWarningMs: number;
}) {
  const router = useRouter();
  const [starting, setStarting] = useState(false);
  const [testId, setTestId] = useState<string | null>(null);
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [progress, setProgress] = useState<SampleDataProgress | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const { test, slowWorker } = useConnectionTest(testId, queuedWarningMs);

  async function startWithSample() {
    setProblem(null);
    setStarting(true);
    const started = await startSampleData().catch(() => null);
    if (!started?.ok) {
      setStarting(false);
      setProblem(started?.message ?? "The sample data couldn't be checked. Check your connection and try again.");
      return;
    }
    setTestId(started.testId);
  }

  // The check settled: connect it, or say why it can't be.
  useEffect(() => {
    if (!test || connectionId) return;
    if (test.status === "passed" || test.status === "warning") {
      let stopped = false;
      void connectSampleData(test.id).then((result) => {
        if (stopped) return;
        if (result.ok) setConnectionId(result.connectionId);
        else {
          setStarting(false);
          setTestId(null);
          setProblem(result.message);
        }
      });
      return () => {
        stopped = true;
      };
    }
    if (test.status === "failed" || test.status === "blocked") {
      setStarting(false);
      setProblem("The sample data couldn't be reached from this server. Try again, or connect your own database.");
    }
  }, [test, connectionId]);

  // Connected: its schema is read, then its tables are chosen and learned. Followed until it's being learned, which
  // is enough to go on: the last step waits for it.
  useEffect(() => {
    if (!connectionId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const next = await sampleDataProgress(connectionId).catch(() => null);
      if (stopped) return;
      if (next) setProgress(next);
      if (next?.phase === "failed") {
        setStarting(false);
        setProblem(next.message);
        return;
      }
      if (next?.phase === "learning" || next?.phase === "ready") {
        router.push("/get-started/ai");
        router.refresh();
        return;
      }
      timer = setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [connectionId, router]);

  const pair = (state: PairState) => <Pair size={64} state={state} />;
  const skip = (
    <Link href="/get-started/ai" className={buttonVariants({ variant: "ghost" })}>
      Skip for now
    </Link>
  );

  // Under way here: its progress stays until it moves on, whatever the server has noticed meanwhile.
  if (starting) {
    const reading = progress?.phase === "reading" || (connectionId !== null && !progress);
    return (
      <StepSheet
        pair={pair("working")}
        title="Connecting the sample data"
        lead="The same checks every source gets: that OpenDash can reach it, and that it can only read."
        footer={
          <>
            <span className="text-small text-muted">This takes a few seconds.</span>
            <span className="flex-1" />
            {skip}
          </>
        }
      >
        <ul aria-live="polite" className="flex flex-col">
          {test?.checks.length ? (
            test.checks.map((check) => <CheckRow key={check.key} check={check} />)
          ) : (
            <Line state="doing">Reaching play.clickhouse.com</Line>
          )}
          {connectionId ? (
            <>
              <Line
                state={reading ? "doing" : "done"}
                detail={progress?.tables ? `${progress.tables} tables` : undefined}
              >
                Reading its tables
              </Line>
              <Line state={reading ? "todo" : "doing"}>Choosing the best ones to start with</Line>
            </>
          ) : null}
        </ul>
        {slowWorker ? (
          <Alert status="warning">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>
                No worker has picked up the check yet. Make sure the OpenDash worker is running.
              </Alert.Description>
            </Alert.Content>
          </Alert>
        ) : null}
      </StepSheet>
    );
  }

  if (source) {
    return (
      <StepSheet
        pair={pair(source.working ? "working" : "success")}
        title={source.working ? `Learning ${source.name}` : `${source.name} is connected`}
        lead={
          source.working
            ? "OpenDash is reading its tables and what's in them. You can go on meanwhile."
            : "Your data is in place. You can connect more sources any time under Data."
        }
        footer={
          <>
            <span className="flex-1" />
            <Link href="/get-started/ai" className={`${buttonVariants()} gap-1.5`}>
              Continue
              <ArrowRight className="size-4" aria-hidden />
            </Link>
          </>
        }
      >
        <p className="flex items-center gap-2 rounded-2xl bg-success-soft px-4 py-3 text-body text-success-soft-foreground">
          <CircleCheck className="size-4 shrink-0 text-success" aria-hidden />
          {source.sample
            ? "The sample data: ClickHouse's public playground."
            : "Queried in place, with a read-only user."}
        </p>
      </StepSheet>
    );
  }

  return (
    <StepSheet
      wide
      pair={pair(problem ? "attention" : "idle")}
      title="Where's your data?"
      lead="OpenDash queries your database in place, with a read-only user. Only the results of your questions are stored."
      footer={
        <>
          <Link href="/get-started" className={buttonVariants({ variant: "ghost" })}>
            Back
          </Link>
          <span className="flex-1" />
          {skip}
        </>
      }
    >
      {problem ? (
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{problem}</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
      {canSetUp ? (
        <div className="grid gap-4 md:grid-cols-2">
          <section
            aria-labelledby="sample-title"
            className="flex flex-col gap-4 rounded-3xl border border-accent bg-accent-soft p-5"
          >
            <div className="flex items-center gap-2">
              <ClickHouseLogo className="size-6 shrink-0" />
              <h2 id="sample-title" className="flex-1 text-heading">
                Try it with sample data
              </h2>
              <Chip size="sm" color="accent" variant="soft">
                Fastest
              </Chip>
            </div>
            <p className="text-body text-muted">
              ClickHouse's public playground: real, open datasets to ask about. Nothing to set up, nothing of yours
              involved.
            </p>
            <ul className="flex flex-wrap gap-1.5">
              {DATASETS.map((name) => (
                <li key={name} className="flex h-6 items-center rounded-md bg-surface px-2 text-small text-muted">
                  {name}
                </li>
              ))}
            </ul>
            <span className="flex-1" />
            <Button onPress={startWithSample} fullWidth>
              Use sample data
            </Button>
          </section>
          <section aria-labelledby="own-title" className="flex flex-col gap-4 rounded-3xl border border-border p-5">
            <h2 id="own-title" className="flex h-6 items-center text-heading">
              Connect your own database
            </h2>
            <p className="text-body text-muted">
              Give OpenDash a read-only user. It checks that the user can't change anything before it runs a query.
            </p>
            <ul className="flex flex-col gap-2">
              {OWN.map(({ kind, label, Logo }) => (
                <li key={kind}>
                  <Link
                    href={`/get-started/data/${kind}`}
                    className="flex h-11 items-center gap-3 rounded-xl border border-border px-3 text-body font-medium hover:bg-surface-secondary"
                  >
                    <Logo className="size-5 shrink-0" />
                    <span className="flex-1">{label}</span>
                    <ArrowRight className="size-4 text-muted-tertiary" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
            <p className="flex items-center gap-1.5 text-small text-muted-tertiary">
              <Lock className="size-3.5 shrink-0" aria-hidden />
              Passwords are stored encrypted, and never shown again.
            </p>
          </section>
        </div>
      ) : (
        <p className="rounded-2xl bg-surface-secondary px-4 py-3 text-body text-muted">
          An owner or admin of this workspace connects its data. You can look around meanwhile.
        </p>
      )}
    </StepSheet>
  );
}

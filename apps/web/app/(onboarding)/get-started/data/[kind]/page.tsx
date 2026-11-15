import { BUDGETS } from "@opendash/core";
import { notFound, redirect } from "next/navigation";
import { OnboardingShell } from "@/components/onboarding/onboarding-shell";
import { SourceConnect } from "@/components/sources/source-connect";
import { authSettings } from "@/lib/auth";
import { onboardingState } from "@/lib/onboarding";
import { egressAddresses } from "@/lib/sources";

const KINDS = ["postgres", "mysql", "clickhouse"] as const;

/**
 * Step 1, with a database of the person's own: the app's own connect form (the settings, the live check, the review
 * of what the user can do), inside the guided setup, which it goes on with once the source is connected.
 */
export default async function ConnectOwnPage({ params }: { params: Promise<{ kind: string }> }) {
  const { kind } = await params;
  const known = KINDS.find((k) => k === kind);
  if (!known) notFound();
  const state = await onboardingState();
  if (!state.canSetUp) redirect("/get-started/data");
  const { edition } = await authSettings();
  return (
    <OnboardingShell current="data" done={{ data: Boolean(state.source), ai: state.model.ready, ask: state.asked }}>
      <section className="enter-rise w-full max-w-2xl rounded-sheet border border-hero-glass-stroke bg-surface p-6 shadow-glass sm:p-8">
        <SourceConnect
          kind={known}
          egress={edition === "cloud" ? egressAddresses() : []}
          queuedWarningMs={BUDGETS.connectionTest.queuedWarningMs}
          guided
        />
      </section>
    </OnboardingShell>
  );
}

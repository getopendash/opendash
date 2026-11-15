import { BUDGETS } from "@opendash/core";
import { DataStep } from "@/components/onboarding/data-step";
import { OnboardingShell } from "@/components/onboarding/onboarding-shell";
import { onboardingState } from "@/lib/onboarding";

/** Step 1: the workspace's data. The sample data in one press, or a database of the person's own. */
export default async function DataStepPage() {
  const state = await onboardingState();
  return (
    <OnboardingShell current="data" done={{ data: Boolean(state.source), ai: state.model.ready, ask: state.asked }}>
      <DataStep
        source={state.source}
        canSetUp={state.canSetUp}
        queuedWarningMs={BUDGETS.connectionTest.queuedWarningMs}
      />
    </OnboardingShell>
  );
}

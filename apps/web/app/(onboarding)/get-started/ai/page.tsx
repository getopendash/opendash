import { ModelStep } from "@/components/onboarding/model-step";
import { OnboardingShell } from "@/components/onboarding/onboarding-shell";
import { onboardingState } from "@/lib/onboarding";

/** Step 2: a model to answer with. Done already where the deployment has its own keys. */
export default async function ModelStepPage() {
  const state = await onboardingState();
  return (
    <OnboardingShell current="ai" done={{ data: Boolean(state.source), ai: state.model.ready, ask: state.asked }}>
      <ModelStep
        canSetUp={state.canSetUp}
        ready={state.model.ready ? { label: state.model.label, through: state.model.through } : null}
      />
    </OnboardingShell>
  );
}

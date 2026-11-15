import { learningChoice } from "@opendash/core";
import { withTenant } from "@opendash/db";
import { AskStep } from "@/components/onboarding/ask-step";
import { OnboardingShell } from "@/components/onboarding/onboarding-shell";
import { onboardingState, starterQuestions } from "@/lib/onboarding";

/** Step 3: a first question, from a few that fit the source, or the person's own. */
export default async function AskStepPage() {
  const state = await onboardingState();
  // The sample data's questions are about its tables: only the ones it has learned are offered.
  const learned = state.source?.sample
    ? await withTenant({ orgId: state.orgId, userId: state.user.id }, async (tx) => {
        const choice = await learningChoice(tx, state.orgId, state.source?.id ?? "");
        return (choice?.tables ?? []).filter((t) => t.ticked).map((t) => t.name);
      })
    : [];
  return (
    <OnboardingShell current="ask" done={{ data: Boolean(state.source), ai: state.model.ready, ask: state.asked }}>
      <AskStep
        source={state.source}
        modelReady={state.model.ready}
        questions={starterQuestions(state.source, learned)}
      />
    </OnboardingShell>
  );
}

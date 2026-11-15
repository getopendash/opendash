import { buttonVariants } from "@heroui/react";
import { Pair } from "@opendash/ui";
import { ArrowRight, Check, Database, Sparkles } from "lucide-react";
import Link from "next/link";
import { OnboardingShell } from "@/components/onboarding/onboarding-shell";
import { Showcase } from "@/components/onboarding/showcase";
import { onboardingState } from "@/lib/onboarding";

/**
 * The welcome: who OpenDash is, what it does (shown in three small scenes), and the two things between here and a
 * first answer, with what's already there ticked. One button in, one way to skip.
 */
export default async function WelcomePage() {
  const state = await onboardingState();
  const first = state.user.name.trim().split(/\s+/)[0] || "there";
  const hasData = Boolean(state.source);
  // Straight to what's missing: someone who comes back doesn't repeat a step.
  const next = !hasData ? "/get-started/data" : !state.model.ready ? "/get-started/ai" : "/get-started/ask";
  const needs = [
    {
      icon: Database,
      done: hasData,
      title: "Your data",
      line: hasData ? `${state.source?.name} is connected.` : "A read-only database, or our sample data in one click.",
    },
    {
      icon: Sparkles,
      done: state.model.ready,
      title: "A model",
      line: state.model.ready
        ? `${state.model.label ?? "A model"} is ready to answer.`
        : "A key from Anthropic, OpenAI or Google.",
    },
  ];
  return (
    <OnboardingShell current="welcome" done={{}}>
      <div className="flex w-full max-w-4xl flex-col items-center gap-7 text-center">
        <div className="enter-rise flex flex-col items-center gap-3">
          <Pair size={64} interactive />
          <h1 className="text-hero">
            Welcome, {first}. <span className="text-link">Let's get your first answer.</span>
          </h1>
          <p className="max-w-2xl text-heading font-normal leading-relaxed text-muted">
            OpenDash is an analyst for your data. Ask a question in plain language, and it writes the queries, checks
            the math in code, and shows you where every number came from.
          </p>
        </div>
        <Showcase />
        <div className="enter-fade flex w-full max-w-2xl flex-col gap-5">
          <ul className="grid gap-3 text-start sm:grid-cols-2">
            {needs.map((need) => (
              <li
                key={need.title}
                className="flex items-start gap-3 rounded-2xl border border-hero-glass-stroke bg-hero-glass-tint px-4 py-3 backdrop-blur-glass"
              >
                <span
                  className={`mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full ${
                    need.done ? "bg-success-soft text-success" : "bg-surface text-muted"
                  }`}
                >
                  {need.done ? (
                    <Check className="size-3.5" aria-label="Done" />
                  ) : (
                    <need.icon className="size-3.5" aria-hidden />
                  )}
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="text-body font-medium">{need.title}</span>
                  <span className="text-small text-muted">{need.line}</span>
                </span>
              </li>
            ))}
          </ul>
          <div className="flex flex-col items-center gap-2">
            <Link href={next} className={`${buttonVariants({ size: "lg" })} gap-1.5 px-6`}>
              {/* "Continue" only for what the person did themselves: a model the server came with isn't their progress. */}
              {hasData ? "Continue setup" : "Get started"}
              <ArrowRight className="size-4" aria-hidden />
            </Link>
            <p className="text-small text-muted">
              About two minutes with the sample data.{" "}
              <Link href="/" className="text-link hover:underline">
                Skip and look around
              </Link>
            </p>
          </div>
        </div>
      </div>
    </OnboardingShell>
  );
}

import { buttonVariants } from "@heroui/react";
import { OpenDashLogo } from "@opendash/ui";
import { Check } from "lucide-react";
import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import type { OnboardingStepKey } from "@/lib/onboarding";

/** The steps the bar counts: the welcome isn't one, it's the door. */
const COUNTED: { key: OnboardingStepKey; label: string; href: string }[] = [
  { key: "data", label: "Data", href: "/get-started/data" },
  { key: "ai", label: "Model", href: "/get-started/ai" },
  { key: "ask", label: "First question", href: "/get-started/ask" },
];

/**
 * The guided setup's frame (/get-started): the whole window on the brand's gradient, with the logo, where the person
 * is in the three steps, and the way out. Every step can be left: "Skip setup" opens OpenDash as it is, and what's
 * done so far stays done.
 */
export function OnboardingShell({
  current,
  done,
  children,
}: {
  current: OnboardingStepKey;
  /** The steps whose thing is there already (a source, a model), whatever page this is. */
  done: Partial<Record<OnboardingStepKey, boolean>>;
  children: ReactNode;
}) {
  return (
    <div className="auth-hero flex min-h-dvh flex-col">
      <header className="flex items-center gap-4 px-5 py-4 sm:px-8 sm:py-5">
        <Link href="/" aria-label="OpenDash" className="flex flex-1 items-center text-foreground">
          <OpenDashLogo className="h-7" label={null} />
        </Link>
        {current === "welcome" ? null : (
          <nav aria-label="Setup steps">
            <ol className="hidden items-center gap-2 text-small sm:flex">
              {COUNTED.map((step, i) => {
                const active = step.key === current;
                const ticked = Boolean(done[step.key]) && !active;
                return (
                  <Fragment key={step.key}>
                    {i > 0 ? <li aria-hidden className="h-px w-6 bg-hero-glass-stroke" /> : null}
                    <li aria-current={active ? "step" : undefined}>
                      <Link
                        href={step.href}
                        className={`flex h-7 items-center gap-1.5 rounded-full border px-2.5 ${
                          active
                            ? "border-hero-glass-stroke bg-surface font-medium text-foreground shadow-glass"
                            : "border-transparent text-muted hover:text-foreground"
                        }`}
                      >
                        <span
                          className={`flex size-4.5 items-center justify-center rounded-full text-micro font-medium ${
                            ticked
                              ? "bg-success-soft text-success"
                              : active
                                ? "bg-accent text-accent-foreground"
                                : "border border-border-secondary"
                          }`}
                        >
                          {ticked ? <Check className="size-3" aria-label="Done" /> : i + 1}
                        </span>
                        {step.label}
                      </Link>
                    </li>
                  </Fragment>
                );
              })}
            </ol>
          </nav>
        )}
        <div className="flex flex-1 justify-end">
          <Link href="/" className={buttonVariants({ variant: "ghost", size: "sm" })}>
            Skip setup
          </Link>
        </div>
      </header>
      <main className="flex flex-1 flex-col items-center justify-center px-4 pt-2 pb-12 sm:px-8">{children}</main>
    </div>
  );
}

/**
 * A step's sheet: what Pair says about it (the heading and a line under it), the step's own content, and its footer
 * (back, skip, continue).
 */
export function StepSheet({
  pair,
  title,
  lead,
  children,
  footer,
  wide = false,
}: {
  pair: ReactNode;
  title: string;
  lead: ReactNode;
  children: ReactNode;
  footer: ReactNode;
  wide?: boolean;
}) {
  return (
    <section
      className={`enter-rise flex w-full flex-col gap-6 rounded-sheet border border-hero-glass-stroke bg-surface p-6 shadow-glass sm:p-8 ${
        wide ? "max-w-3xl" : "max-w-2xl"
      }`}
    >
      <div className="flex items-start gap-4">
        <span className="shrink-0">{pair}</span>
        <div className="flex min-w-0 flex-col gap-1.5">
          <h1 className="text-display">{title}</h1>
          <p className="text-body text-muted">{lead}</p>
        </div>
      </div>
      {children}
      <div className="flex flex-wrap items-center gap-2 border-separator border-t pt-5">{footer}</div>
    </section>
  );
}

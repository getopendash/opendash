import { Check } from "lucide-react";
import { Fragment } from "react";

const steps = ["Workspace", "Data", "Model", "First question"];

/**
 * Where creating the workspace sits in getting started: the first of four, the other three being the guided setup's
 * (/get-started). `current` is 1-based. Connectors stretch so the row fits the form width.
 */
export function OnboardingStepper({ current }: { current: number }) {
  return (
    <ol className="flex items-center gap-2 text-small">
      {steps.map((label, i) => {
        const n = i + 1;
        const done = n < current;
        const active = n === current;
        return (
          <Fragment key={label}>
            {i > 0 ? <li aria-hidden className="h-px min-w-2 flex-1 bg-separator" /> : null}
            <li
              className="flex shrink-0 items-center gap-1.5 whitespace-nowrap"
              aria-current={active ? "step" : undefined}
            >
              <span
                className={`flex size-4.5 items-center justify-center rounded-full text-micro font-medium ${
                  active
                    ? "bg-accent text-accent-foreground"
                    : done
                      ? "bg-accent-soft text-accent-soft-foreground"
                      : "border border-border text-muted"
                }`}
              >
                {done ? <Check className="size-3" aria-hidden /> : n}
              </span>
              <span className={active ? "font-medium text-foreground" : "text-muted"}>{label}</span>
            </li>
          </Fragment>
        );
      })}
    </ol>
  );
}

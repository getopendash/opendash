"use client";

import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * A choice among a few cards, one picked at a time, inside a `role="radiogroup"` the page gives:
 * `TriggerCard`, what starts a routine (on a schedule, when something is found), and `ConditionTile`, what counts as
 * found (unusual, crosses a line, a goal at risk, data missing). Picked, it takes the accent.
 */
function ChoiceCard({
  kind,
  icon: Icon,
  title,
  description,
  selected,
  disabled,
  onSelect,
  children,
}: {
  kind: "trigger" | "condition";
  icon: LucideIcon;
  title: string;
  description: string;
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
  children?: ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a card-sized radio with its own layout; ARIA says what it is
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      className="choice-card"
      data-kind={kind}
      data-selected={selected ? "" : undefined}
      onClick={onSelect}
    >
      <span className="choice-card__icon">
        <Icon className="size-4" aria-hidden />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-start">
        <span className="text-body font-medium">{title}</span>
        <span className="choice-card__description text-small">{description}</span>
        {children}
      </span>
      {kind === "trigger" ? <span className="choice-card__radio rounded-full" aria-hidden /> : null}
    </button>
  );
}

/** What starts a routine: on a schedule, or when something is found. */
export function TriggerCard(props: Omit<Parameters<typeof ChoiceCard>[0], "kind">) {
  return <ChoiceCard {...props} kind="trigger" />;
}

/** What counts as found: unusual, crosses a line, a goal at risk, its data missing. */
export function ConditionTile(props: Omit<Parameters<typeof ChoiceCard>[0], "kind">) {
  return <ChoiceCard {...props} kind="condition" />;
}

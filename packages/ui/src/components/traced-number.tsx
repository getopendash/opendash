"use client";

/**
 * Traced Number: a figure from a query cell, never from model text. Pressing it opens its trace:
 * the cell, the query and the checks behind it. Unverified ones (the answer gate couldn't check them) are
 * underlined in the warning colour.
 */
export function TracedNumber({
  display,
  selected = false,
  unverified = false,
  onPress,
  label,
}: {
  display: string;
  selected?: boolean;
  unverified?: boolean;
  onPress?: () => void;
  /** For screen readers: what pressing it shows. */
  label?: string;
}) {
  return (
    <button
      type="button"
      onClick={onPress}
      aria-pressed={selected}
      aria-label={label ?? `${display}: show where this number comes from`}
      className={`traced-number -mx-0.5 rounded-sm px-0.5 underline-offset-2 ${selected ? "traced-number--selected" : ""} ${unverified ? "traced-number--unverified" : ""}`}
    >
      {display}
    </button>
  );
}

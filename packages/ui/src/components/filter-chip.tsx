"use client";

import { Button, Checkbox, Popover, SearchField } from "@heroui/react";
import { ChevronDown, ListFilter } from "lucide-react";
import { useEffect, useState } from "react";

const same = (a: string[], b: string[]) => a.length === b.length && a.every((v) => b.includes(v));

/**
 * The values a filter's popover lists: the ones offered, plus any applied or ticked that aren't among them (no longer
 * the largest, or found by a search), so unticking one never makes it vanish. By name; or, for a column's list, in
 * the order given with the applied ones first.
 */
export function listedValues(values: string[], chosen: string[], draft: string[], ordered = false): string[] {
  const extra = [...new Set([...chosen, ...draft])].filter((d) => !values.includes(d));
  return ordered
    ? [...new Set([...chosen, ...values, ...extra])]
    : [...new Set([...values, ...extra])].sort((a, b) => a.localeCompare(b));
}

/**
 * One of a dashboard's filters: a chip that reads "Plan" until values are chosen, then "Plan: Starter" in
 * the accent. Its popover lists the values to choose from (with how often each occurs, when it's known); the choice
 * applies on Apply, so a dashboard re-runs once per decision rather than once per checkbox. Clear lifts it; the owner
 * also gets "Remove filter". With `onSearch`, a search finds values beyond the ones listed (a column's, read live).
 */
export function FilterChip({
  label,
  values,
  chosen,
  onApply,
  onRemove,
  note,
  state = "ready",
  error,
  onSearch,
  searchPlaceholder,
  counts,
  ordered = false,
}: {
  label: string;
  /** The values to choose from (the field's largest, from the data). */
  values: string[];
  chosen: string[];
  onApply: (values: string[]) => void;
  /** For the dashboard's owner: removes the filter from the dashboard. */
  onRemove?: () => void;
  /** Where the values come from: "Values found in MRR over its last 12 months." */
  note?: string;
  state?: "loading" | "ready" | "error";
  error?: string;
  /** Finds values that contain the search (debounced); the caller passes what it found as `values`. */
  onSearch?: (search: string) => void;
  searchPlaceholder?: string;
  /** How many rows hold each value, shown beside it. */
  counts?: Record<string, number>;
  /** Keep the values in the order given (most common first) rather than by name. */
  ordered?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string[]>(chosen);
  const [search, setSearch] = useState("");
  const active = chosen.length > 0;
  useEffect(() => {
    if (!onSearch) return;
    const t = setTimeout(() => onSearch(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search, onSearch]);
  const listed = listedValues(values, chosen, draft, ordered);
  const text = !active ? label : chosen.length === 1 ? `${label}: ${chosen[0]}` : `${label}: ${chosen.length} chosen`;
  const apply = (next: string[]) => {
    setOpen(false);
    if (!same(next, chosen)) onApply(next);
  };
  return (
    <Popover
      isOpen={open}
      onOpenChange={(o) => {
        if (o) setDraft(chosen);
        setOpen(o);
      }}
    >
      <Button
        size="sm"
        variant="outline"
        className={active ? "border-accent bg-accent-soft text-accent-soft-foreground" : ""}
        aria-label={active ? `${label} filter: ${chosen.join(", ")}` : `Filter by ${label.toLowerCase()}`}
      >
        <ListFilter className="size-3.5" aria-hidden />
        <span className="max-w-48 truncate">{text}</span>
        <ChevronDown className="size-3" aria-hidden />
      </Button>
      <Popover.Content placement="bottom start" className="w-64">
        <Popover.Dialog className="flex flex-col gap-3 p-1">
          <Popover.Heading className="text-small font-semibold">{label}</Popover.Heading>
          {onSearch ? (
            <SearchField aria-label={`Search ${label.toLowerCase()}`} value={search} onChange={setSearch} fullWidth>
              <SearchField.Group>
                <SearchField.SearchIcon />
                <SearchField.Input placeholder={searchPlaceholder ?? `Search ${label.toLowerCase()}`} />
                <SearchField.ClearButton />
              </SearchField.Group>
            </SearchField>
          ) : null}
          {state === "loading" ? (
            <p className="text-small text-muted">Reading its values…</p>
          ) : state === "error" ? (
            <p className="text-small text-muted">{error ?? "Its values couldn't be read."}</p>
          ) : listed.length ? (
            <div className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
              {listed.map((v) => (
                <Checkbox
                  key={v}
                  isSelected={draft.includes(v)}
                  onChange={(on) => setDraft(on ? [...draft, v] : draft.filter((d) => d !== v))}
                  className="flex flex-row items-center gap-2 rounded-lg px-1 py-1 hover:bg-default"
                >
                  <Checkbox.Control>
                    <Checkbox.Indicator />
                  </Checkbox.Control>
                  <Checkbox.Content className="flex min-w-0 flex-1 items-baseline justify-between gap-2 text-small">
                    <span className="truncate">{v}</span>
                    {counts?.[v] !== undefined ? (
                      <span className="shrink-0 text-micro text-muted-tertiary tabular-nums">
                        {counts[v]?.toLocaleString("en-US")}
                      </span>
                    ) : null}
                  </Checkbox.Content>
                </Checkbox>
              ))}
            </div>
          ) : (
            <p className="text-small text-muted">
              {search.trim() ? `Nothing contains “${search.trim()}”.` : "No values in this period."}
            </p>
          )}
          {note && state === "ready" ? <p className="text-small text-muted-tertiary">{note}</p> : null}
          <div className="flex items-center gap-2">
            {onRemove ? (
              <Button
                size="sm"
                variant="ghost"
                className="text-danger"
                onPress={() => {
                  setOpen(false);
                  onRemove();
                }}
              >
                Remove filter
              </Button>
            ) : null}
            <span className="flex-1" />
            <Button size="sm" variant="ghost" isDisabled={!active && !draft.length} onPress={() => apply([])}>
              Clear
            </Button>
            <Button size="sm" isDisabled={same(draft, chosen)} onPress={() => apply(draft)}>
              Apply
            </Button>
          </div>
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  );
}

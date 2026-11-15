"use client";

import { Button, Checkbox, Chip, SearchField, toast } from "@heroui/react";
import { isDefinedError } from "@opendash/api/client";
import type { LearningChoice } from "@opendash/core";
import { useMutation } from "@tanstack/react-query";
import { GraduationCap, Link2, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { api } from "@/lib/api";
import { alsoLearn, joinedByText, learningWhy, shortName } from "@/lib/source-learning";

/** Rows shown before a search: the most useful, and everything picked. */
const SHOWN = 12;

/**
 * What OpenDash learns of a source. Every table, most useful first, the picked ones ticked: they
 * are profiled on every sync and drafted into definitions; the rest stay known (the analyst can still query them, and
 * checks one for personal data the first time it does). Saving starts a sync that learns the new picks.
 */
export function LearningChoiceScreen({
  connectionId,
  sourceName,
  choice,
  done,
}: {
  connectionId: string;
  sourceName: string;
  choice: LearningChoice;
  /** Where to go once it's saved (the source's Overview). */
  done: string;
}) {
  const router = useRouter();
  const [picked, setPicked] = useState(() => new Set(choice.tables.filter((t) => t.ticked).map((t) => t.name)));
  const [filter, setFilter] = useState("");
  const save = useMutation({
    mutationFn: () => api.sources.chooseLearned({ connectionId, tables: [...picked] }),
  });
  const toggle = (name: string, on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });
  // Only the filter and the list change what's shown, so a tick never moves a row out from under the pointer.
  // biome-ignore lint/correctness/useExhaustiveDependencies: picked is read once per filter, on purpose
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (q) return choice.tables.filter((t) => t.name.toLowerCase().includes(q));
    // The most useful first; anything picked further down stays in view.
    const top = choice.tables.slice(0, SHOWN);
    const below = choice.tables.slice(SHOWN).filter((t) => picked.has(t.name) || t.new);
    return [...top, ...below];
  }, [filter, choice.tables]);
  const hint = alsoLearn(choice.tables, picked);
  // Whether OpenDash can see how the team queries it: without a history, tables rank by their joins and size.
  const history = choice.tables.some((t) => t.queries > 0);
  const n = picked.size;
  const rest = choice.tables.length - shown.length;
  const first = !choice.chosen;
  const submit = () =>
    save.mutate(undefined, {
      onSuccess: (r) => {
        toast.success(`OpenDash is learning ${r.learned} ${r.learned === 1 ? "table" : "tables"} of ${sourceName}.`);
        router.push(done);
        router.refresh();
      },
      onError: (e) =>
        toast.danger(isDefinedError(e) ? (e as { message: string }).message : "Couldn't save what's learned."),
    });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-display">{first ? "Choose what OpenDash learns" : "What OpenDash learns"}</h1>
        <p className="max-w-reading text-body text-muted">
          {first
            ? `OpenDash read ${sourceName}'s schema${history ? " and how your team queries it" : ""}. Pick the tables it should learn: it profiles them, finds their joins and drafts definitions from them. The rest stay known: the analyst can still query them, and checks each for personal data the first time.`
            : `The tables ticked are learned: profiled on every sync, their joins checked, drafted into definitions. The rest are known: the analyst can still query them.`}
        </p>
      </div>

      <section aria-labelledby="learn-tables" className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="learn-tables" className="flex items-baseline gap-2 text-body font-medium">
            Tables
            <span className="text-small font-normal text-muted">
              {n} of {choice.tables.length} picked
              {first
                ? history
                  ? " · the ones your team queries most"
                  : " · the ones most joined, then the largest"
                : ""}
            </span>
          </h2>
          <SearchField aria-label="Find a table" value={filter} onChange={setFilter} className="w-full max-w-64">
            <SearchField.Group>
              <SearchField.SearchIcon />
              <SearchField.Input placeholder="Find a table" />
              <SearchField.ClearButton />
            </SearchField.Group>
          </SearchField>
        </div>
        <ul className="flex flex-col divide-y divide-border rounded-xl border border-border">
          {shown.map((t, i) => (
            <li key={t.name}>
              <Checkbox
                isSelected={picked.has(t.name)}
                onChange={(on) => toggle(t.name, on)}
                className="w-full px-3 py-2 hover:bg-default"
              >
                <Checkbox.Content className="w-full items-center">
                  <Checkbox.Control>
                    <Checkbox.Indicator />
                  </Checkbox.Control>
                  <span className="flex min-w-0 flex-1 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-mono text-body">{t.name}</span>
                      {t.new ? (
                        <Chip size="sm" variant="soft" color="accent">
                          New
                        </Chip>
                      ) : null}
                    </span>
                    <span className="text-small text-muted">{learningWhy(t, i === 0 && !filter, history)}</span>
                  </span>
                </Checkbox.Content>
              </Checkbox>
            </li>
          ))}
          {!shown.length ? <li className="px-3 py-3 text-body text-muted">No table is called that.</li> : null}
          {rest > 0 && !filter ? (
            <li className="px-3 py-2 text-small text-muted-tertiary">
              {rest.toLocaleString("en-US")} more {rest === 1 ? "table" : "tables"} · find one to pick it
            </li>
          ) : null}
        </ul>
        {hint ? (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border px-3 py-2">
            <Link2 className="size-3.5 shrink-0 text-muted-tertiary" aria-hidden />
            <span className="min-w-0 flex-1 text-small text-muted">
              {joinedByText(hint.joinedBy)} {hint.joinedBy.length === 1 ? "joins" : "join"} {shortName(hint.table)},
              which isn't picked.
            </span>
            <Button size="sm" variant="ghost" onPress={() => toggle(hint.table, true)}>
              <Plus className="size-3.5" aria-hidden />
              Also learn {shortName(hint.table)}
            </Button>
          </div>
        ) : null}
      </section>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
        <p className="max-w-reading text-small text-muted">
          Next: OpenDash profiles {n === 1 ? "this table" : `these ${n}`} (a few minutes) and checks their joins. You
          can change this any time from the source's Overview.
        </p>
        <Button size="sm" isPending={save.isPending} isDisabled={n === 0} onPress={submit}>
          <GraduationCap className="size-3.5" aria-hidden />
          Learn {n} {n === 1 ? "table" : "tables"}
        </Button>
      </div>
    </div>
  );
}

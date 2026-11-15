"use client";

import type { ModelChoice, OfferedGroup } from "@opendash/core";
import { ModelPicker, type PickerGroup, type PickerValue } from "@opendash/ui";
import { useQuery } from "@tanstack/react-query";
import { CircleAlert } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { apiQueries } from "@/lib/api";

/** Where a person's last choice is kept: the model, the provider it ran on, and its level. */
const KEY = "opendash:ask-choice";

/** The offered models as the picker groups them. */
export const pickerGroups = (offered: OfferedGroup[]): PickerGroup[] =>
  offered.map((g) => ({
    provider: g.provider,
    label: g.label,
    short: g.short,
    mono: g.mono,
    note: g.note,
    models: g.models,
  }));

function remembered(): PickerValue | null {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (!v || typeof v !== "object") return null;
    const { model, provider, reasoning } = v as Record<string, unknown>;
    return typeof model === "string" && typeof provider === "string" && typeof reasoning === "string"
      ? { model, provider, reasoning }
      : null;
  } catch {
    // No storage (a private window), or something else under the key: the default it is.
    return null;
  }
}

/** The kept choice while its provider still offers its model (at the model's default if it lost the level), else the default. */
function resolve(kept: PickerValue | null, offered: OfferedGroup[], fallback: ModelChoice | null): ModelChoice | null {
  const group = kept ? offered.find((g) => g.provider === kept.provider) : undefined;
  const model = group?.models.find((m) => m.id === kept?.model);
  if (!group || !model) return fallback;
  return {
    model: model.id,
    provider: group.provider,
    // The level kept when this model takes it; otherwise the model's first default the server sends (its maker's).
    reasoning: model.levels.find((l) => l === kept?.reasoning) ?? model.defaultLevel,
  };
}

/**
 * The model for this question: the person's last choice of model, provider and thinking, remembered in
 * their browser, while it's still offered; else the team's default. What's sent is always what the picker shows; with
 * nothing on offer nothing is (the server's default, whose run says what's missing).
 */
export function useChosenModel() {
  const offered = useQuery(apiQueries.ai.models.queryOptions());
  const [kept, setKept] = useState<PickerValue | null>(null);
  useEffect(() => setKept(remembered()), []);
  const data = offered.data;
  const groups = useMemo(() => pickerGroups(data?.offered ?? []), [data]);
  const value = resolve(kept, data?.offered ?? [], data?.default ?? null);
  const choose = (next: PickerValue) => {
    setKept(next);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // Remembered for this page only.
    }
  };
  return {
    value,
    groups,
    levels: data?.levels ?? [],
    team: data?.default ?? null,
    manage: data?.manage ?? null,
    choose,
  };
}

export type ChosenModel = ReturnType<typeof useChosenModel>;

const andList = (names: string[]) =>
  names.length < 3 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/**
 * The composer's model button: the models by provider, the thinking below, and what's under them. Admins
 * see a provider that isn't working and the way to Settings → AI; everyone else, who chooses what's offered.
 */
export function ChatModelPicker({ chosen }: { chosen: ChosenModel }) {
  const { manage } = chosen;
  return (
    <ModelPicker
      name="Model for this question"
      variant="ghost"
      placement="top start"
      groups={chosen.groups}
      levels={chosen.levels}
      value={chosen.value}
      team={chosen.team}
      onChange={chosen.choose}
      footer={(close) =>
        manage ? (
          <>
            {manage.notWorking.length ? (
              <span className="flex min-w-0 items-center gap-1.5">
                <CircleAlert className="size-3.5 shrink-0" aria-hidden />
                <span className="truncate">
                  {andList(manage.notWorking)} {manage.notWorking.length === 1 ? "isn't" : "aren't"} working
                </span>
              </span>
            ) : null}
            <Link href="/settings/ai" onClick={close} className="ms-auto shrink-0 text-link hover:underline">
              Manage providers
            </Link>
          </>
        ) : (
          <span>Your admins choose what's offered.</span>
        )
      }
    />
  );
}

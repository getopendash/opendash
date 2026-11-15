"use client";

import { Button, Input, Label, ProgressBar, TextField, toast } from "@heroui/react";
import { isDefinedError } from "@opendash/api/client";
import type { SpendView } from "@opendash/core";
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiQueries } from "@/lib/api";

const WARN_AT = 0.8;
const money = (n: number) => `$${n.toFixed(2)}`;
const field = (v: number | null) => (v === null ? "" : String(v));
/** "", or a positive amount; anything else is null with an error. */
const parse = (s: string): { value: number | null; error: string | null } => {
  const t = s.trim().replace(/^\$/, "").replaceAll(",", "");
  if (!t) return { value: null, error: null };
  const n = Number(t);
  return Number.isFinite(n) && n > 0 && n <= 1_000_000
    ? { value: Math.round(n * 100) / 100, error: null }
    : { value: null, error: "An amount over $0, or empty for none." };
};
/** A budget: an amount, $0 to turn it off; never empty (background work always has one). */
const parseBudget = (s: string): { value: number | null; error: string | null } => {
  const t = s.trim().replace(/^\$/, "").replaceAll(",", "");
  const n = Number(t);
  return t && Number.isFinite(n) && n >= 0 && n <= 1_000_000
    ? { value: Math.round(n * 100) / 100, error: null }
    : { value: null, error: "The background budget is an amount, $0 to turn it off." };
};

function Limit({
  label,
  period,
  spent,
  limit,
  value,
  onChange,
  error,
  note,
  placeholder = "No limit",
}: {
  label: string;
  period: string;
  spent: number;
  limit: number | null;
  value: string;
  onChange: (v: string) => void;
  error: string | null;
  /** What it covers, after the amounts. */
  note?: string;
  placeholder?: string;
}) {
  const share = limit ? spent / limit : 0;
  const warn = limit !== null && share >= WARN_AT;
  return (
    <li className="flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3.5">
      <span className="flex w-40 flex-col">
        <span className="text-body font-medium">{label}</span>
        <span className="text-small text-muted-tertiary">{period}</span>
      </span>
      <span className="flex min-w-48 flex-1 flex-col gap-1.5">
        {limit === 0 ? (
          <span className="text-small text-muted">Off · {money(spent)} spent this month</span>
        ) : limit !== null ? (
          <>
            <ProgressBar
              aria-label={`${label}: ${money(spent)} of ${money(limit)}`}
              size="sm"
              value={Math.min(spent, limit)}
              maxValue={limit}
              color={warn ? "warning" : "accent"}
              className="max-w-sm"
            >
              <ProgressBar.Track>
                <ProgressBar.Fill />
              </ProgressBar.Track>
            </ProgressBar>
            <span
              className={`text-small tabular-nums ${warn ? "font-medium text-warning-soft-foreground" : "text-muted"}`}
            >
              {money(spent)} of {money(limit)} · {Math.floor(share * 100)}%{note ? ` · ${note}` : ""}
            </span>
          </>
        ) : (
          <span className="text-small text-muted">{money(spent)} so far · no limit</span>
        )}
      </span>
      <TextField
        aria-label={`${label} in dollars`}
        value={value}
        onChange={onChange}
        isInvalid={error !== null}
        className="w-32"
      >
        <Label className="sr-only">{label}</Label>
        <Input inputMode="decimal" placeholder={placeholder} />
      </TextField>
    </li>
  );
}

/**
 * The organization's spend limits on Settings → Usage: this month's and today's spend on questions against
 * their limits, and background work's against its own budget (the Investigator, routines' written summaries and
 * questions), which the questions'
 * limits never count. Owners and admins (the page only renders for them, and the API refuses anyone else).
 */
export function SpendLimits({ initial }: { initial: SpendView }) {
  const router = useRouter();
  const [view, setView] = useState(initial);
  const [monthly, setMonthly] = useState(field(initial.limits.monthlyUsd));
  const [daily, setDaily] = useState(field(initial.limits.dailyUsd));
  const [background, setBackground] = useState(String(initial.limits.backgroundMonthlyUsd));
  const [ceiling, setCeiling] = useState(field(initial.limits.runCeilingUsd));
  const save = useMutation(apiQueries.usage.setLimits.mutationOptions());
  const m = parse(monthly);
  const d = parse(daily);
  const b = parseBudget(background);
  const c = parse(ceiling);
  const dirty =
    m.value !== view.limits.monthlyUsd ||
    d.value !== view.limits.dailyUsd ||
    b.value !== view.limits.backgroundMonthlyUsd ||
    c.value !== view.limits.runCeilingUsd;
  const error = m.error ?? d.error ?? b.error ?? c.error;
  const resets = new Date(view.resets.month).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  const month = new Date(new Date(view.resets.month).getTime() - 1).toLocaleDateString("en-US", {
    month: "long",
    timeZone: "UTC",
  });
  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-body font-semibold">Spend limits</h2>
        <p className="text-small text-muted-tertiary">
          New questions stop once a limit is reached; ones already running finish. Background work has a budget of its
          own, so it never uses the questions' limits.
        </p>
      </div>
      <ul className="flex flex-col divide-y divide-border rounded-2xl border border-border">
        <Limit
          label="Monthly limit"
          period={`${month} · resets ${resets}`}
          spent={view.spent.month}
          limit={view.limits.monthlyUsd}
          value={monthly}
          onChange={setMonthly}
          error={m.error}
        />
        <Limit
          label="Daily limit"
          period="Today · resets at 00:00 UTC"
          spent={view.spent.day}
          limit={view.limits.dailyUsd}
          value={daily}
          onChange={setDaily}
          error={d.error}
        />
        <Limit
          label="Background work"
          period={`${month} · resets ${resets}`}
          spent={view.spent.background}
          limit={view.limits.backgroundMonthlyUsd}
          value={background}
          onChange={setBackground}
          error={b.error}
          note="the Investigator, and routines' summaries and questions"
          placeholder="10"
        />
        <li className="flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3.5">
          <span className="flex w-40 flex-col">
            <span className="text-body font-medium">One run</span>
            <span className="text-small text-muted-tertiary">Each question or build</span>
          </span>
          <span className="min-w-48 flex-1 text-small text-muted">
            {view.limits.runCeilingUsd === null
              ? "No ceiling: a run goes on until it's done or stopped; the limits above still hold."
              : `Pauses at ${money(view.limits.runCeilingUsd)} and asks to continue. Nothing it did is lost.`}
          </span>
          <TextField
            aria-label="One run's ceiling in dollars"
            value={ceiling}
            onChange={setCeiling}
            isInvalid={c.error !== null}
            className="w-32"
          >
            <Label className="sr-only">One run</Label>
            <Input inputMode="decimal" placeholder="No ceiling" />
          </TextField>
        </li>
      </ul>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          isDisabled={!dirty || error !== null}
          isPending={save.isPending}
          onPress={() =>
            save.mutate(
              {
                monthlyUsd: m.value,
                dailyUsd: d.value,
                backgroundMonthlyUsd: b.value ?? undefined,
                runCeilingUsd: c.value,
              },
              {
                onSuccess: (next) => {
                  setView(next);
                  toast.success("Limits saved.");
                  router.refresh();
                },
                onError: (e) =>
                  toast.danger(isDefinedError(e) ? (e as { message: string }).message : "Couldn't save them."),
              },
            )
          }
        >
          Save limits
        </Button>
        <span className="text-small text-muted-tertiary">
          {error ?? "Leave a limit or the ceiling empty for none; $0 turns background work off."}
        </span>
      </div>
    </section>
  );
}

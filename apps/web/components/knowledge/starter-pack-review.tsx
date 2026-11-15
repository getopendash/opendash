"use client";

import { Button, buttonVariants, Checkbox, toast } from "@heroui/react";
import type { CheckStatus } from "@opendash/core";
import { Check, CircleMinus, Sigma, Table2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useState, useTransition } from "react";
import { approveDefinitions } from "@/app/(app)/knowledge/actions";
import { ChecksChip } from "./definition-status";

export interface ReviewItem {
  id: string;
  kind: "dataset" | "metric";
  title: string;
  slug: string;
  connectionName: string;
  checks: CheckStatus | null;
  /** A metric's dataset (its item id), which has to be approved with it. */
  datasetId: string | null;
  /** A dataset of snapshots: a longer period reads its last one. */
  snapshot?: boolean;
}

/**
 * Drafted definitions, reviewed. Everything that passed its tests starts selected; picking a metric picks
 * its dataset too, and dropping a dataset drops its metrics, so what's approved always holds together. The sample's
 * starter pack moves on to Metrics once approved; a source's drafts (`drafts`) stay, for what's left to review, and
 * say what the Modeler left out.
 */
export function StarterPackReview({
  items,
  panels,
  canApprove,
  drafts,
}: {
  items: ReviewItem[];
  panels: Record<string, ReactNode>;
  canApprove: boolean;
  drafts?: { leftOut: { name: string; reason: string }[]; skipHref: string };
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [selected, setSelected] = useState(() => new Set(items.filter((i) => i.checks === "passed").map((i) => i.id)));
  const [open, setOpen] = useState(items[0]?.id ?? null);
  const groups = [
    { kind: "dataset" as const, label: "Datasets", list: items.filter((i) => i.kind === "dataset") },
    { kind: "metric" as const, label: "Metrics", list: items.filter((i) => i.kind === "metric") },
  ].filter((g) => g.list.length);

  const toggle = (item: ReviewItem, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) {
        next.add(item.id);
        if (item.datasetId) next.add(item.datasetId);
      } else {
        next.delete(item.id);
        if (item.kind === "dataset") for (const m of items) if (m.datasetId === item.id) next.delete(m.id);
      }
      return next;
    });
  const approve = () =>
    start(async () => {
      const r = await approveDefinitions([...selected]);
      if ("message" in r) {
        toast.danger(r.message);
        return;
      }
      toast.success(
        `${r.approved} ${r.approved === 1 ? "definition" : "definitions"} approved. Ask answers with them now.`,
      );
      if (!drafts) router.push("/knowledge/metrics");
      router.refresh();
    });

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex min-h-0 flex-1 flex-col gap-4 @5xl/page:flex-row">
        <div className="flex flex-col gap-4 overflow-y-auto rounded-2xl border border-border p-3 @5xl/page:w-96 @5xl/page:shrink-0">
          {groups.map((g) => (
            <section key={g.kind} className="flex flex-col gap-0.5">
              <header className="flex items-center justify-between px-1.5 py-1">
                <h2 className="text-small font-medium text-muted">
                  {g.label} · {g.list.length}
                </h2>
                <button
                  type="button"
                  className="text-small text-link hover:underline"
                  onClick={() => {
                    for (const i of g.list) toggle(i, true);
                  }}
                >
                  Select all
                </button>
              </header>
              <ul className="flex flex-col gap-0.5">
                {g.list.map((i) => (
                  <li
                    key={i.id}
                    className={`flex items-center gap-2.5 rounded-xl px-1.5 py-1.5 ${open === i.id ? "bg-default" : "hover:bg-default"}`}
                  >
                    <Checkbox
                      aria-label={`Approve ${i.title}`}
                      isSelected={selected.has(i.id)}
                      onChange={(on) => toggle(i, on)}
                    >
                      <Checkbox.Control>
                        <Checkbox.Indicator />
                      </Checkbox.Control>
                    </Checkbox>
                    <button
                      type="button"
                      onClick={() => setOpen(i.id)}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    >
                      {i.kind === "metric" ? (
                        <Sigma className="size-3.5 shrink-0 text-muted" aria-hidden />
                      ) : (
                        <Table2 className="size-3.5 shrink-0 text-muted" aria-hidden />
                      )}
                      <span className="truncate text-body">{i.title}</span>
                      <span className="hidden truncate font-mono text-small text-muted-tertiary @5xl/page:inline">
                        {i.slug}
                      </span>
                      {i.snapshot ? (
                        <span className="shrink-0 rounded-md bg-surface-secondary px-1.5 text-micro font-medium text-muted">
                          Snapshot
                        </span>
                      ) : null}
                    </button>
                    <ChecksChip checks={i.checks} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {drafts?.leftOut.length ? (
            <ul className="flex flex-col gap-1.5 px-1.5">
              {drafts.leftOut.map((l) => (
                <li key={l.name} className="flex items-start gap-1.5 text-small text-muted">
                  <CircleMinus className="mt-0.5 size-3.5 shrink-0 text-muted-tertiary" aria-hidden />
                  <span>
                    Left out: <span className="font-medium">{l.name}</span>. {l.reason}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <div className="min-w-0 flex-1 overflow-y-auto rounded-2xl border border-border p-6">
          {open ? panels[open] : null}
        </div>
      </div>
      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
        <p className="text-body">
          <span className="font-medium">
            {selected.size} of {items.length} selected
          </span>
          <span className="text-muted">
            {drafts
              ? " · Approving makes them the definitions Ask, dashboards and routines use."
              : " · Approving makes them the definitions Ask answers with."}
          </span>
        </p>
        <div className="flex items-center gap-2">
          <Link href={drafts?.skipHref ?? "/"} className={buttonVariants({ size: "sm", variant: "outline" })}>
            Skip for now
          </Link>
          {canApprove ? (
            <Button size="sm" isPending={pending} isDisabled={!selected.size} onPress={approve}>
              <Check className="size-3.5" aria-hidden />
              {drafts
                ? `Approve ${selected.size} ${selected.size === 1 ? "definition" : "definitions"}`
                : `Approve ${selected.size} and continue`}
            </Button>
          ) : (
            <span className="text-small text-muted">An owner or admin approves these.</span>
          )}
        </div>
      </footer>
    </div>
  );
}

"use client";

import { Button, buttonVariants, Popover, Spinner } from "@heroui/react";
import { Eye, Repeat } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { answerWatchAction } from "@/app/(app)/ask/routine-actions";
import { WatchChoices } from "@/components/routines/watch-choices";
import { answerOf } from "@/lib/action-answer";

/** Repeat… on an answer: the composer, asking this question again on a schedule. */
export function RepeatAnswer({ runId }: { runId: string }) {
  return (
    <Link
      href={`/routines/new?run=${encodeURIComponent(runId)}`}
      className={buttonVariants({ size: "sm", variant: "ghost" })}
    >
      <Repeat className="size-3.5" aria-hidden />
      Repeat…
    </Link>
  );
}

type Loaded = Awaited<ReturnType<typeof answerWatchAction>>;

/**
 * Watch on an answer about verified metrics: what watching each metric it read offers, as on a
 * dashboard's tile. Read when it's opened.
 */
export function WatchAnswer({ runId }: { runId: string }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const load = async () => setLoaded(await answerOf(() => answerWatchAction(runId)));
  return (
    <Popover
      onOpenChange={(open) => {
        if (open) void load();
      }}
    >
      <Button size="sm" variant="ghost">
        <Eye className="size-3.5" aria-hidden />
        Watch
      </Button>
      <Popover.Content placement="top" className="w-80">
        <Popover.Dialog className="flex max-h-96 flex-col gap-3 overflow-y-auto p-1">
          {!loaded ? (
            <span className="flex items-center gap-2 text-small text-muted">
              <Spinner size="sm" />
              Reading what it's about…
            </span>
          ) : !loaded.ok ? (
            <span className="text-small text-muted">{loaded.message}</span>
          ) : !loaded.metrics.length ? (
            <span className="text-small text-muted">
              It doesn't read a verified metric that can be watched: one with weeks or months.
            </span>
          ) : (
            loaded.metrics.map(({ metric, watch }, i) => (
              <div key={metric.id} className={`flex flex-col gap-3 ${i ? "border-t border-border pt-3" : ""}`}>
                <Popover.Heading className="text-body font-medium">Watch {metric.title}</Popover.Heading>
                <WatchChoices
                  metric={metric}
                  watch={watch}
                  canManage={loaded.canManage}
                  onChanged={() => void load()}
                />
              </div>
            ))
          )}
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  );
}

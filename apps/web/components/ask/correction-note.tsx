"use client";

import { Button } from "@heroui/react";
import type { CorrectionKept } from "@opendash/core";
import { useMutation } from "@tanstack/react-query";
import { BookmarkCheck, RotateCcw } from "lucide-react";
import { apiQueries } from "@/lib/api";

/**
 * A correction someone gave on an answer, and what it was kept as: their memory (their next questions follow it)
 * and a learning for the team (the Curator turns it into a term an admin approves with one tap, or the
 * rule releases); before that, a proposed guide. "Answer again with this" asks again in this conversation; Undo takes
 * the thumbs back, and with it the memory and the learning's evidence.
 */
export function CorrectionNote({
  runId,
  kept,
  onAsk,
  onUndone,
}: {
  runId: string;
  kept: CorrectionKept;
  onAsk?: (text: string) => void;
  onUndone: () => void;
}) {
  const withdraw = useMutation(apiQueries.feedback.withdraw.mutationOptions({ onSuccess: onUndone }));
  return (
    <section className="flex flex-col gap-2 rounded-xl border border-border p-3" aria-label="Correction saved">
      <span className="flex items-center gap-2 text-body font-medium">
        <BookmarkCheck className="size-4 text-success" aria-hidden />
        {kept.memory ? "Saved to your memory" : "Sent to an admin"}
      </span>
      <p className="text-small text-muted">
        “{kept.memory?.fact ?? kept.text}” {kept.memory ? "Your next questions use it. " : ""}
        {kept.learningId
          ? "OpenDash is checking it as a learning for the team: once approved, everyone's analyst uses it too."
          : kept.guideId
            ? "An admin got it as a proposed guide: once approved, everyone's analyst uses it too."
            : ""}
      </p>
      <span className="flex items-center gap-1.5">
        {onAsk ? (
          <Button size="sm" onPress={() => onAsk(`Answer again with my correction: ${kept.text}`)}>
            <RotateCcw className="size-3.5" aria-hidden />
            Answer again with this
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" isPending={withdraw.isPending} onPress={() => withdraw.mutate({ runId })}>
          Undo
        </Button>
      </span>
    </section>
  );
}

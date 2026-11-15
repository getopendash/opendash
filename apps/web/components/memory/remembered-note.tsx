"use client";

import { Button, toast } from "@heroui/react";
import { useMutation } from "@tanstack/react-query";
import { Bookmark, BookmarkCheck, BookmarkX } from "lucide-react";
import { useState, useTransition } from "react";
import { restoreAction, undoRememberAction } from "@/app/(app)/knowledge/memory/actions";
import { apiQueries } from "@/lib/api";

/**
 * Under an answer, what the analyst did with the person's memory, with Undo for its owner (a shared conversation's
 * readers see that it was done for the asker):
 * - "Remembered for you: …" when it kept something they asked it to, or a correction or preference they
 *   stated; Undo forgets it and keeps again the older memories it replaced about the same thing.
 * - "No longer remembered: …" when it let one go on their word; Undo keeps it again.
 */
export function RememberedNote({
  id,
  fact,
  canUndo,
  forgotten = false,
  replaced = [],
  canShare = false,
}: {
  id: string;
  fact: string;
  canUndo: boolean;
  /** A correction: its owner may share it with the team's learning about it. */
  canShare?: boolean;
  /** The older memories it replaced, kept again on Undo. */
  replaced?: string[];
  /** The analyst forgot it, rather than kept it. */
  forgotten?: boolean;
}) {
  const [undone, setUndone] = useState(false);
  const [shared, setShared] = useState(false);
  const [pending, start] = useTransition();
  const share = useMutation(
    apiQueries.learning.suggest.mutationOptions({
      onSuccess: () => {
        setShared(true);
        toast.success("Suggested for the team: OpenDash checks it, and an admin can make it everyone's.");
      },
      onError: (error) => toast.danger(error.message),
    }),
  );
  const undo = () =>
    start(async () => {
      const done = forgotten ? (await restoreAction(id)).restored : (await undoRememberAction(id, replaced)).forgotten;
      if (done) setUndone(true);
      else toast.danger(forgotten ? "It can't be brought back." : "It was already forgotten.");
    });
  const Icon = forgotten ? (undone ? BookmarkCheck : BookmarkX) : Bookmark;
  const gone = forgotten !== undone;
  const label = forgotten
    ? undone
      ? "Remembered again: "
      : canUndo
        ? "No longer remembered: "
        : "No longer remembered for the asker: "
    : undone
      ? "Forgotten: "
      : canUndo
        ? "Remembered for you: "
        : "Remembered for the asker: ";
  return (
    <div className="flex items-center gap-2 rounded-xl bg-surface-secondary px-3 py-2 text-small">
      <Icon className={`size-3.5 shrink-0 ${gone ? "text-muted" : "text-accent"}`} aria-hidden />
      <span className={`flex-1 ${!forgotten && undone ? "text-muted-tertiary line-through" : "text-muted"}`}>
        {label}“{fact}”
      </span>
      {canUndo && canShare && !forgotten && !undone && !shared ? (
        <Button size="sm" variant="ghost" isPending={share.isPending} onPress={() => share.mutate({ memoryId: id })}>
          Suggest for the team
        </Button>
      ) : null}
      {canUndo && !undone ? (
        <Button size="sm" variant="ghost" isPending={pending} onPress={undo}>
          Undo
        </Button>
      ) : null}
    </div>
  );
}

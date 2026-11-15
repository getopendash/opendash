"use client";

import { Check, Timer, X } from "lucide-react";

/** A follow-up as the thread gives it. */
export interface FollowUpView {
  id: string;
  text: string;
  state: "queued" | "next" | "read";
}

const SAID: Record<FollowUpView["state"], string> = {
  queued: "OpenDash will read this next",
  next: "OpenDash will answer this next",
  read: "Read while answering",
};

/**
 * A message sent while the answer was worked on. Queued, it waits under the answer and its author can take
 * it back; read, it sits with the question it was added to.
 */
export function FollowUpBubble({ followUp, onTakeBack }: { followUp: FollowUpView; onTakeBack?: () => void }) {
  const waiting = followUp.state !== "read";
  return (
    <div className="flex max-w-xl flex-col items-end gap-1.5 self-end">
      <p
        className={`whitespace-pre-line rounded-2xl px-3.5 py-2 text-lead ${waiting ? "border border-border bg-surface text-muted" : "bg-default"}`}
      >
        {followUp.text}
      </p>
      <span className="flex items-center gap-1.5 px-1 text-small text-muted-tertiary">
        {waiting ? <Timer className="size-3" aria-hidden /> : <Check className="size-3" aria-hidden />}
        {SAID[followUp.state]}
        {waiting && onTakeBack ? (
          <button
            type="button"
            aria-label="Take it back"
            onClick={onTakeBack}
            className="rounded text-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-accent"
          >
            <X className="size-3" aria-hidden />
          </button>
        ) : null}
      </span>
    </div>
  );
}

"use client";

import { Button, Label, Popover, TextArea, TextField, toast } from "@heroui/react";
import type { ReasonCode } from "@opendash/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ThumbsDown, ThumbsUp } from "lucide-react";
import { useState } from "react";
import { apiQueries } from "@/lib/api";

const REASON_LABELS: { code: ReasonCode; label: string }[] = [
  { code: "wrong_number", label: "A number is wrong" },
  { code: "wrong_definition", label: "Wrong definition" },
  { code: "missing_context", label: "Missing context" },
  { code: "misread_question", label: "Misread the question" },
  { code: "other", label: "Something else" },
];

/**
 * 👍 / 👎 on an answer (explicit signals). A thumbs down asks what was wrong; saying
 * what it should have said makes it a correction, kept as the person's memory and proposed to the team as a guide
 * (its note is the run's CorrectionNote). Both can be taken back by pressing again. Admins read the reports in
 * Knowledge → Feedback.
 */
export function AnswerFeedback({ runId }: { runId: string }) {
  const client = useQueryClient();
  const key = apiQueries.feedback.mine.queryOptions({ input: { runId } });
  const { data } = useQuery(key);
  const refresh = () => client.invalidateQueries({ queryKey: key.queryKey });
  const give = useMutation(apiQueries.feedback.give.mutationOptions({ onSuccess: refresh }));
  const withdraw = useMutation(apiQueries.feedback.withdraw.mutationOptions({ onSuccess: refresh }));
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<ReasonCode | null>(null);
  const [comment, setComment] = useState("");
  const current = data?.answer?.kind ?? null;

  const up = () => (current === "up" ? withdraw.mutate({ runId }) : give.mutate({ runId, kind: "up" }));
  const send = () => {
    const text = comment.trim();
    give.mutate(
      { runId, kind: "down", ...(reason ? { reasonCode: reason } : {}), ...(text ? { comment: text } : {}) },
      {
        onSuccess: (r) => {
          setOpen(false);
          // A correction shows its note under the answer; anything else goes to the admins.
          if (!r.correction) toast.success("Thanks. An admin will look at this answer.");
        },
      },
    );
  };

  return (
    <span className="flex items-center gap-0.5">
      <Button
        isIconOnly
        size="sm"
        variant="ghost"
        aria-label={current === "up" ? "Take back: helpful" : "Helpful"}
        aria-pressed={current === "up"}
        onPress={up}
      >
        <ThumbsUp className={`size-3.5 ${current === "up" ? "fill-current text-accent" : "text-muted"}`} aria-hidden />
      </Button>
      <Popover
        isOpen={open}
        onOpenChange={(next) => {
          if (next && current === "down") {
            withdraw.mutate({ runId });
            return;
          }
          if (next) {
            setReason(data?.answer?.reasonCode ?? null);
            setComment(data?.answer?.comment ?? "");
          }
          setOpen(next);
        }}
      >
        <Button
          isIconOnly
          size="sm"
          variant="ghost"
          aria-label={current === "down" ? "Take back: not right" : "Not right"}
          aria-pressed={current === "down"}
        >
          <ThumbsDown
            className={`size-3.5 ${current === "down" ? "fill-current text-danger" : "text-muted"}`}
            aria-hidden
          />
        </Button>
        <Popover.Content placement="top start" className="w-80">
          <Popover.Dialog className="flex flex-col gap-3 p-3">
            <Popover.Heading className="text-body font-medium">What's not right?</Popover.Heading>
            <div className="flex flex-wrap gap-1.5">
              {REASON_LABELS.map((r) => (
                <Button
                  key={r.code}
                  size="sm"
                  variant={reason === r.code ? "secondary" : "outline"}
                  aria-pressed={reason === r.code}
                  onPress={() => setReason(reason === r.code ? null : r.code)}
                >
                  {r.label}
                </Button>
              ))}
            </div>
            <TextField value={comment} onChange={setComment} className="flex flex-col gap-1">
              <Label className="text-small">What should it have said?</Label>
              <TextArea rows={3} placeholder="Paying accounts are the active subscriptions, not the trial accounts." />
            </TextField>
            <p className="text-small text-muted-tertiary">
              The analyst remembers it for your next questions. Checked and tested, it can become a team learning: an
              admin taps once.
            </p>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onPress={() => setOpen(false)}>
                Cancel
              </Button>
              <Button size="sm" isPending={give.isPending} onPress={send}>
                Send
              </Button>
            </div>
          </Popover.Dialog>
        </Popover.Content>
      </Popover>
    </span>
  );
}

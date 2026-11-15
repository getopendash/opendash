"use client";

import { Button, Input, Label, TextArea, TextField, toast } from "@heroui/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Flag } from "lucide-react";
import { useState } from "react";
import { apiQueries } from "@/lib/api";

/**
 * H5's "This is wrong": someone says a number in the answer is wrong, and optionally what's right. It lands in
 * Knowledge → Feedback, and on the page of each definition the answer used.
 */
export function ReportNumber({ runId, queryRunId, claimKey }: { runId: string; queryRunId: string; claimKey: string }) {
  const client = useQueryClient();
  const key = apiQueries.feedback.mine.queryOptions({ input: { runId } });
  const { data } = useQuery(key);
  const give = useMutation(
    apiQueries.feedback.give.mutationOptions({ onSuccess: () => client.invalidateQueries({ queryKey: key.queryKey }) }),
  );
  const [open, setOpen] = useState(false);
  const [correction, setCorrection] = useState("");
  const [comment, setComment] = useState("");
  const reported = data?.numbers.includes(claimKey) ?? false;

  if (reported && !open) {
    return (
      <p className="flex items-center gap-1.5 text-small text-muted">
        <Flag className="size-3.5 text-danger" aria-hidden />
        You reported this number. An admin will look at it.
      </p>
    );
  }
  if (!open) {
    return (
      <Button size="sm" variant="outline" className="w-fit" onPress={() => setOpen(true)}>
        <Flag className="size-3.5" aria-hidden />
        This is wrong
      </Button>
    );
  }
  return (
    <form
      className="flex flex-col gap-2.5 rounded-xl border border-border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        give.mutate(
          {
            runId,
            queryRunId,
            claimKey,
            kind: "wrong_number",
            ...(correction.trim() ? { correction } : {}),
            ...(comment.trim() ? { comment } : {}),
          },
          {
            onSuccess: () => {
              setOpen(false);
              toast.success("Reported. An admin will look at this number.");
            },
          },
        );
      }}
    >
      <TextField value={correction} onChange={setCorrection} className="flex flex-col gap-1">
        <Label className="text-small">What's right? (optional)</Label>
        <Input placeholder="412k, or how it should be counted" />
      </TextField>
      <TextField value={comment} onChange={setComment} className="flex flex-col gap-1">
        <Label className="text-small">Why (optional)</Label>
        <TextArea rows={2} placeholder="It should leave out refunds" />
      </TextField>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onPress={() => setOpen(false)}>
          Cancel
        </Button>
        <Button size="sm" type="submit" isPending={give.isPending}>
          Report
        </Button>
      </div>
    </form>
  );
}

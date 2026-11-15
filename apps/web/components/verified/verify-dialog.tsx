"use client";

import { Button, Input, Label, Modal, TextArea, TextField, toast } from "@heroui/react";
import { ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { saveVerifiedAction } from "@/app/(app)/knowledge/verified/actions";
import { describeSpec, type MetricSpecLike } from "@/lib/metric-spec";

/**
 * Saves an answer's metric query as a verified query (`queryRunId`), or edits one's question and wordings (`id`).
 * Shows what the query computes and its result, so saving is a review.
 */
export function VerifyDialog({
  target,
  question: initialQuestion,
  phrasings: initialPhrasings = [],
  spec,
  titles = {},
  result,
  isOpen,
  onOpenChange,
}: {
  target: { queryRunId: string } | { id: string };
  question: string;
  phrasings?: string[];
  spec: MetricSpecLike;
  /** Metric titles by slug. */
  titles?: Record<string, string>;
  /** Its result in a line ("2 rows"). */
  result?: string;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [question, setQuestion] = useState(initialQuestion);
  const [also, setAlso] = useState(initialPhrasings.join("\n"));
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const editing = "id" in target;
  const save = () =>
    start(async () => {
      setProblem(null);
      const r = await saveVerifiedAction({
        ...target,
        question,
        phrasings: also
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean),
      });
      if ("message" in r) {
        setProblem(r.message);
        return;
      }
      onOpenChange(false);
      toast.success(editing ? `Saved version ${r.version}.` : "Saved as a verified query.", {
        description: editing ? undefined : (
          <Link href={`/knowledge/verified/${r.id}`} className="text-link underline">
            Open it
          </Link>
        ),
      });
      router.refresh();
    });
  return (
    <Modal>
      <Modal.Backdrop isOpen={isOpen} onOpenChange={onOpenChange}>
        <Modal.Container size="md">
          <Modal.Dialog>
            <Modal.Header className="flex flex-col gap-1">
              <Modal.Heading>{editing ? "Edit the verified query" : "Save as a verified query"}</Modal.Heading>
              <p className="text-body text-muted">
                When someone asks a question like this, the analyst follows this query and adapts the period to theirs.
                {editing ? "" : " Saving it verifies it."}
              </p>
            </Modal.Header>
            <Modal.Body className="flex flex-col gap-5">
              <TextField value={question} onChange={setQuestion} className="flex flex-col gap-1.5">
                <Label>Question</Label>
                <Input maxLength={300} />
                <span className="text-small text-muted-tertiary">Word it the way people ask it.</span>
              </TextField>
              <TextField value={also} onChange={setAlso} className="flex flex-col gap-1.5">
                <Label>Also asked as</Label>
                <TextArea rows={3} placeholder="One wording per line, optional" />
                <span className="text-small text-muted-tertiary">One wording per line, optional.</span>
              </TextField>
              <div className="flex flex-col gap-1.5">
                <span className="text-body font-medium">What it computes</span>
                <SpecRows spec={spec} titles={titles} />
                {result ? <span className="text-small text-muted-tertiary">{result}</span> : null}
              </div>
              {problem ? <p className="text-small text-danger">{problem}</p> : null}
            </Modal.Body>
            <Modal.Footer className="flex justify-end gap-2">
              <Button variant="ghost" slot="close">
                Cancel
              </Button>
              <Button isPending={pending} isDisabled={question.trim().length < 3} onPress={save}>
                <ShieldCheck className="size-3.5" aria-hidden />
                {editing ? "Save" : "Save as verified"}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}

/** What a metric query computes, as label and value rows. */
export function SpecRows({ spec, titles = {} }: { spec: MetricSpecLike; titles?: Record<string, string> }) {
  return (
    <dl className="flex flex-col gap-1 rounded-xl bg-surface-secondary px-3 py-2 text-small">
      {describeSpec(spec, titles).map(([k, v]) => (
        <div key={`${k}-${v}`} className="flex gap-3">
          <dt className="w-28 shrink-0 text-muted-tertiary">{k}</dt>
          <dd className="min-w-0">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

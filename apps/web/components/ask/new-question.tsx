"use client";

import type { AskableSource } from "@opendash/api/client";
import type { ModelChoice } from "@opendash/core";
import { useQuery } from "@tanstack/react-query";
import { CornerDownRight } from "lucide-react";
import { useState } from "react";
import { apiQueries } from "@/lib/api";
import { startingSource } from "@/lib/starting-source";
import { AskComposer } from "./ask-composer";
import type { AttachedItem } from "./attach-picker";
import { useChosenModel } from "./model-picker";
import { useStartThread } from "./use-start-thread";

/**
 * A new question. The composer in the middle, the source it's about, and three questions to start with, built
 * from what OpenDash learned (there are no metrics yet, so they're about tables), each asked with the model chosen in
 * the composer. Asking opens the conversation.
 */
export function NewQuestion({
  sources,
  initialSource,
  initialText,
  project,
  attached,
}: {
  sources: AskableSource[];
  initialSource: string | null;
  initialText?: string;
  /** Asked from a project: the conversation starts in it, shared with its people. */
  project?: { id: string; name: string };
  /** Attached from the start: a skill being tried (its page's Try now). */
  attached?: AttachedItem[];
}) {
  const sourceId = startingSource(sources, initialSource);
  const source = sources.find((s) => s.id === sourceId) ?? null;
  const suggested = useQuery({
    ...apiQueries.sources.suggestions.queryOptions({ input: { connectionId: sourceId ?? "" } }),
    enabled: sourceId !== null,
  });
  const suggestions = suggested.data ?? [];
  const { start, pending, error } = useStartThread(project?.id);
  // Shared with the suggestions below, so one asks with the model the composer shows.
  const chosen = useChosenModel();
  const submit = (text: string, choice: ModelChoice | null, attachments: AttachedItem[]) =>
    sourceId && start(sourceId, text, choice, attachments);

  return (
    <div className="mx-auto flex w-full max-w-reading flex-col gap-6 pt-24">
      <div className="flex flex-col items-center gap-1.5 text-center">
        <h1 className="text-title">
          {project ? `Ask in ${project.name}` : source ? `Ask about ${source.name}` : "Ask a question"}
        </h1>
        <p className="text-body text-muted">
          {project
            ? `The conversation is shared with ${project.name}'s people. OpenDash checks every number and shows the query behind it.`
            : "OpenDash writes SQL over your tables, checks every number, and shows the query behind it."}
        </p>
      </div>
      <AskComposer
        sources={sources}
        sourceId={sourceId}
        placeholder={source ? `Ask anything about ${source.name}…` : "Ask a question…"}
        initialAttachments={attached ?? []}
        running={false}
        pending={pending}
        error={error}
        onSubmit={submit}
        chosen={chosen}
        autoFocus
        {...(initialText ? { initialText } : {})}
      />
      {suggestions.length ? (
        <div className="flex flex-col items-center gap-3">
          <div className="flex flex-wrap justify-center gap-2">
            {suggestions.map((q) => (
              <button
                key={q}
                type="button"
                disabled={pending}
                onClick={() => submit(q, chosen.value, attached ?? [])}
                className="flex items-center gap-1.5 rounded-xl border border-border px-2.5 py-1 text-small text-muted hover:bg-default hover:text-foreground"
              >
                <CornerDownRight className="size-3" aria-hidden />
                {q}
              </button>
            ))}
          </div>
          <p className="text-small text-muted-tertiary">
            {`Suggested from ${source?.name}'s tables. Answers use verified definitions once there are some.`}
          </p>
        </div>
      ) : null}
    </div>
  );
}

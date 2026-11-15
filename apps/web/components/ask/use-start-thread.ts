"use client";

import { isDefinedError } from "@opendash/api/client";
import type { ModelChoice } from "@opendash/core";
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiQueries } from "@/lib/api";
import { type AttachedItem, sentAttachment } from "./attach-picker";

/** Asks the first question of a new conversation about a source (in a project, when given), then opens it. */
export function useStartThread(projectId?: string) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const ask = useMutation(apiQueries.ask.submit.mutationOptions());
  const start = (
    connectionId: string,
    text: string,
    choice: ModelChoice | null = null,
    attachments: { kind: AttachedItem["kind"]; id: string; version?: number }[] = [],
  ) => {
    setError(null);
    ask.mutate(
      // The client id makes a double submit (a retried request) land on the same conversation.
      {
        text,
        connectionId,
        clientMsgId: crypto.randomUUID(),
        ...(choice ?? {}),
        ...(attachments.length
          ? {
              // A skill keeps the version chosen (Try now on a draft); the server checks who may choose one.
              attachments: attachments.map(sentAttachment),
            }
          : {}),
        ...(projectId ? { projectId } : {}),
      },
      {
        onSuccess: ({ threadId }) => {
          router.push(`/ask/${threadId}`);
          // The shell (the setup card's "Ask your first question") is read on the server: read it again.
          router.refresh();
        },
        onError: (e) => setError(isDefinedError(e) ? e.message : "Couldn't send that. Try again."),
      },
    );
  };
  // Pending until the conversation opens, so a second question can't start a second one.
  return { start, pending: ask.isPending || ask.isSuccess, error };
}

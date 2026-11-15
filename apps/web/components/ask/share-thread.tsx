"use client";

import { toast } from "@heroui/react";
import { isDefinedError } from "@opendash/api/client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { SharePopover, type Visibility } from "@/components/share-popover";
import { apiQueries } from "@/lib/api";

/**
 * The author shares a conversation with the organization for reading, with its project's people (one in a
 * project), or makes it private again.
 */
export function ShareThread({
  threadId,
  org,
  project,
  visibility,
}: {
  threadId: string;
  org: string;
  project?: string | null;
  visibility: Visibility;
}) {
  const queryClient = useQueryClient();
  const share = useMutation(apiQueries.threads.share.mutationOptions());
  const current = share.isPending && share.variables ? share.variables.visibility : visibility;
  return (
    <SharePopover
      title="Share this conversation"
      org={org}
      project={project ?? null}
      value={current}
      pending={share.isPending}
      everyone="They can read the questions, the answers and the query behind each number, including what an answer applied from your memory. Only you can add to it."
      path={`/ask/${threadId}`}
      onChange={(next) =>
        share.mutate(
          { threadId, visibility: next },
          {
            onSuccess: () => void queryClient.invalidateQueries({ queryKey: apiQueries.threads.key() }),
            onError: (e) => toast.danger(isDefinedError(e) ? e.message : "Couldn't change sharing. Try again."),
          },
        )
      }
    />
  );
}

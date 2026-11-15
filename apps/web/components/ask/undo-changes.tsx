"use client";

import { Button, toast } from "@heroui/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Undo2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, apiQueries } from "@/lib/api";

/**
 * "Undo these changes": what this run changed in its dashboards' drafts, put back as they were before it.
 * Offered only where the server says it still can be (nothing saved over it, nothing published since), asked again
 * whenever a dashboard changes; each dashboard put back stays put back, so a refusal on one never strands the others.
 * The page beside the conversation draws the draft again.
 */
export function UndoChanges({ runId, dashboardIds }: { runId: string; dashboardIds: string[] }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  // Under the dashboards' key: any save or undo there asks again.
  const can = useQuery({
    ...apiQueries.dashboards.undoable.queryOptions({ input: { runId, dashboardIds } }),
    staleTime: 0,
  });
  const [busy, setBusy] = useState(false);
  const [undone, setUndone] = useState(false);
  const left = can.data ?? [];
  const undo = async () => {
    setBusy(true);
    let done = 0;
    try {
      for (const dashboardId of left) {
        await api.dashboards.undo({ dashboardId, runId });
        done += 1;
      }
      setUndone(true);
      toast("Put back as it was before this change.");
    } catch (error) {
      toast.danger(error instanceof Error ? error.message : "Couldn't undo it.");
    } finally {
      setBusy(false);
      if (done) {
        void queryClient.invalidateQueries({ queryKey: apiQueries.dashboards.key() });
        router.refresh();
      } else {
        void can.refetch();
      }
    }
  };
  if (undone) return <span className="text-small text-muted">Undone</span>;
  if (!left.length) return null;
  return (
    <Button size="sm" variant="ghost" isDisabled={busy} onPress={() => void undo()}>
      <Undo2 className="size-3.5" aria-hidden />
      Undo these changes
    </Button>
  );
}

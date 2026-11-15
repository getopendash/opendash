"use client";

import { toast } from "@heroui/react";
import { useTransition } from "react";
import { syncSource } from "@/app/(app)/data/sources/actions";

/** A readiness step that a sync does (index values, test definitions again): it starts one, as Sync now does. */
export function ReadinessSync({ sourceId, label }: { sourceId: string; label: string }) {
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const result = await syncSource(sourceId);
          // On success it returns to the source, which shows the sync running.
          if (result?.message) toast.danger(result.message);
        })
      }
      className="text-right text-link hover:underline disabled:opacity-60"
    >
      {label}
    </button>
  );
}

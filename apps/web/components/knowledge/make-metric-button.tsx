"use client";

import { Button, toast } from "@heroui/react";
import { isDefinedError } from "@opendash/api/client";
import { useMutation } from "@tanstack/react-query";
import { Sigma } from "lucide-react";
import Link from "next/link";
import { api } from "@/lib/api";

const message = (e: unknown, fallback: string) => (isDefinedError(e) ? (e as { message: string }).message : fallback);

/** Make this a metric from an answer's query card (Sources): a Modeler run drafts it, for an admin to review. */
export function MakeMetricButton({ queryRunId }: { queryRunId: string }) {
  const request = useMutation({
    mutationFn: () => api.proposals.request({ queryRunId }),
  });
  return (
    <Button
      size="sm"
      variant="outline"
      isPending={request.isPending}
      onPress={() =>
        request.mutate(undefined, {
          onSuccess: (r) =>
            r.status === "held"
              ? toast.warning(
                  "Background work's budget is spent or off, so the draft is held. See Knowledge → Proposals.",
                )
              : toast.success(
                  <span>
                    {r.status === "open"
                      ? "Its metric is already in review."
                      : "OpenDash is drafting a metric from it."}{" "}
                    <Link href="/knowledge/proposals" className="font-medium underline">
                      Proposals
                    </Link>
                  </span>,
                ),
          onError: (e) => toast.danger(message(e, "Couldn't ask for a draft.")),
        })
      }
    >
      <Sigma className="size-3.5" aria-hidden />
      Make this a metric
    </Button>
  );
}

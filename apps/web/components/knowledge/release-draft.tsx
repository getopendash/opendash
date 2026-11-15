"use client";

import { Button, toast } from "@heroui/react";
import { Check } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { releaseDraftAction } from "@/app/(app)/knowledge/release-actions";

/**
 * Releases the version on a definition's page: the one shown, once its tests passed; Ask uses it from the
 * next question. Waits while its tests run, and isn't offered once they failed. "Approve" for one never released
 * (OpenDash's proposal), "Release" for a draft over a released version.
 */
export function ReleaseDraft({
  id,
  title,
  version,
  checks,
  verb = "Release",
}: {
  id: string;
  title: string;
  version: number;
  checks: "passed" | "needs_review" | "failed" | null;
  verb?: "Release" | "Approve";
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const release = () =>
    start(async () => {
      const r = await releaseDraftAction(id, version);
      if (!r.ok) toast.danger(r.message);
      else {
        toast.success(
          `${verb === "Approve" ? "Approved" : "Released"} version ${version} of ${title}: Ask uses it from the next question.`,
        );
      }
      router.refresh();
    });
  return (
    <Button size="sm" isPending={pending} isDisabled={checks === null || checks === "failed"} onPress={release}>
      <Check className="size-3.5" aria-hidden />
      {checks === null ? `${verb} (testing…)` : verb}
    </Button>
  );
}

"use client";

import { Button, toast } from "@heroui/react";
import { Check } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { approveDefinitions } from "@/app/(app)/knowledge/actions";

/** Approves definitions (an owner's or admin's call): they become verified, and Ask uses them from then on. */
export function ApproveButton({ ids, label, size = "sm" }: { ids: string[]; label: string; size?: "sm" | "md" }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      size={size}
      isPending={pending}
      isDisabled={!ids.length}
      onPress={() =>
        start(async () => {
          const r = await approveDefinitions(ids);
          if ("message" in r) toast.danger(r.message);
          else if (r.approved < ids.length) {
            toast.warning(`${r.approved} of ${ids.length} approved: a metric is only approved with its dataset.`);
          } else toast.success(r.approved === 1 ? "Approved." : `${r.approved} definitions approved.`);
          router.refresh();
        })
      }
    >
      <Check className="size-3.5" aria-hidden />
      {label}
    </Button>
  );
}

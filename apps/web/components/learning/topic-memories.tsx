"use client";

import { Button, toast } from "@heroui/react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { forgetAction } from "@/app/(app)/knowledge/memory/actions";

/**
 * A topic's memories, the viewer's own: each with Remove, and once the team's term says what it means,
 * a word that theirs can go when it says the same.
 */
export function TopicMemories({
  memories,
  teamHasIt,
}: {
  memories: { id: string; fact: string; at: string }[];
  teamHasIt: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const remove = (id: string) =>
    start(async () => {
      const { forgotten } = await forgetAction([id]);
      if (!forgotten) {
        toast.danger("That memory is already gone.");
        return;
      }
      toast.success("Removed from your memory.");
      router.refresh();
    });
  return (
    <div className="flex flex-col gap-2">
      {teamHasIt ? (
        <p className="text-small text-muted">
          The team's term says what it means now. If yours says the same, it can go: your answers follow the team's.
        </p>
      ) : null}
      <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border">
        {memories.map((m) => (
          <li key={m.id} className="flex items-center gap-3 px-3 py-2">
            <span className="min-w-0 flex-1 text-body">{m.fact}</span>
            <span className="shrink-0 text-small text-muted-tertiary">
              {new Date(m.at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
            </span>
            <Button size="sm" variant="ghost" isDisabled={pending} onPress={() => remove(m.id)}>
              Remove
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

"use client";

import { Button, toast } from "@heroui/react";
import { Star } from "lucide-react";
import { useEffect, useState, useTransition } from "react";
import { starThreadAction } from "@/app/(app)/ask/actions";

/**
 * A conversation's star: the person's own mark, toggled in place (the row itself still opens what it lists).
 */
export function StarButton({ id, title, starred }: { id: string; title: string; starred: boolean }) {
  const [on, setOn] = useState(starred);
  const [pending, start] = useTransition();
  useEffect(() => setOn(starred), [starred]);
  return (
    <Button
      isIconOnly
      size="sm"
      variant="ghost"
      aria-label={`Star “${title}”`}
      aria-pressed={on}
      isDisabled={pending}
      onPress={() => {
        const next = !on;
        setOn(next);
        start(async () => {
          const r = await starThreadAction(id, next);
          if (!r.ok) {
            setOn(!next);
            toast.danger(r.message);
          }
        });
      }}
    >
      <Star className={`size-3.5 ${on ? "fill-current text-warning" : "text-muted-tertiary"}`} aria-hidden />
    </Button>
  );
}

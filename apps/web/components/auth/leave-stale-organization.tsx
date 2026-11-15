"use client";

import { Button } from "@heroui/react";
import { useTransition } from "react";
import { leaveStaleOrganization } from "@/app/(auth)/left-organization/actions";

/** Moves a session off an organization the person was removed from. */
export function LeaveStaleOrganization() {
  const [pending, start] = useTransition();
  return (
    <Button size="lg" fullWidth isPending={pending} onPress={() => start(() => leaveStaleOrganization())}>
      Continue
    </Button>
  );
}

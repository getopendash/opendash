"use client";

import { Button, toast } from "@heroui/react";
import { Activity, RefreshCw } from "lucide-react";
import { useTransition } from "react";
import { syncSource, testSource } from "@/app/(app)/data/sources/actions";
import { SourceMenu } from "./source-menu";

/** A source's top bar: Test connection, Sync now and the ⋯ menu, for owners and admins. */
export function SourceActions({
  source,
  busy,
}: {
  source: { id: string; name: string; sample: boolean };
  busy: { testing: boolean; syncing: boolean };
}) {
  const id = source.id;
  const [testing, startTest] = useTransition();
  const [syncing, startSync] = useTransition();
  const run = (start: typeof startTest, action: () => Promise<{ message: string } | undefined>) =>
    start(async () => {
      const result = await action();
      if (result?.message) toast.danger(result.message);
    });
  return (
    <div className="flex items-center gap-2">
      <Button
        size="sm"
        variant="outline"
        isPending={testing || busy.testing}
        onPress={() => run(startTest, () => testSource(id))}
      >
        <Activity className="size-3.5" aria-hidden />
        Test connection
      </Button>
      <Button
        size="sm"
        variant="outline"
        isPending={syncing || busy.syncing}
        onPress={() => run(startSync, () => syncSource(id))}
      >
        <RefreshCw className="size-3.5" aria-hidden />
        Sync now
      </Button>
      <SourceMenu source={source} items={["credentials", "delete"]} />
    </div>
  );
}

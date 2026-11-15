"use client";

import { Button, Dropdown, Label, toast } from "@heroui/react";
import { Ellipsis, KeyRound, RefreshCw, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { syncSource } from "@/app/(app)/data/sources/actions";
import { DeleteSourceDialog } from "./delete-source-dialog";

export type SourceMenuItem = "sync" | "credentials" | "delete";

/**
 * A source's ⋯ menu (the sources list's rows, a source's top bar): only actions that work today are offered (future
 * controls are hidden, not disabled). The sample company says "Remove sample data" instead of Delete.
 */
export function SourceMenu({
  source,
  items,
}: {
  source: { id: string; name: string; sample: boolean };
  items: SourceMenuItem[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [deleting, setDeleting] = useState(false);
  if (!items.length) return null;
  const removeLabel = source.sample ? "Remove sample data" : "Delete…";
  return (
    <>
      <Dropdown>
        <Button isIconOnly size="sm" variant="ghost" aria-label={`Actions for ${source.name}`} isPending={pending}>
          <Ellipsis className="text-muted" />
        </Button>
        <Dropdown.Popover placement="bottom end" className="min-w-44">
          <Dropdown.Menu
            onAction={(key) => {
              if (key === "delete") setDeleting(true);
              if (key === "credentials") router.push(`/data/sources/${source.id}/reconnect`);
              if (key === "sync") {
                start(async () => {
                  // On success the action opens the source's page; anything returned is why it didn't start.
                  const result = await syncSource(source.id);
                  if (result?.message) toast.danger(result.message);
                });
              }
            }}
          >
            {items.includes("sync") ? (
              <Dropdown.Item id="sync" textValue="Sync now">
                <RefreshCw className="size-4 text-muted" aria-hidden />
                <Label>Sync now</Label>
              </Dropdown.Item>
            ) : null}
            {items.includes("credentials") ? (
              <Dropdown.Item id="credentials" textValue="Update credentials">
                <KeyRound className="size-4 text-muted" aria-hidden />
                <Label>Update credentials</Label>
              </Dropdown.Item>
            ) : null}
            {items.includes("delete") ? (
              <Dropdown.Item id="delete" textValue={removeLabel} variant="danger">
                <Trash2 className="size-4" aria-hidden />
                <Label>{removeLabel}</Label>
              </Dropdown.Item>
            ) : null}
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>
      <DeleteSourceDialog
        id={source.id}
        name={source.name}
        sample={source.sample}
        isOpen={deleting}
        onOpenChange={setDeleting}
      />
    </>
  );
}

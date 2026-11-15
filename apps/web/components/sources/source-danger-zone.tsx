"use client";

import { Button, Input, Label, TextField, toast } from "@heroui/react";
import { useState, useTransition } from "react";
import { renameSourceAction, setSourceDisabledAction } from "@/app/(app)/data/sources/actions";
import { DeleteSourceDialog } from "./delete-source-dialog";

/** The source's name, saved on its own (no check needed). */
export function RenameSourceForm({ id, name }: { id: string; name: string }) {
  const [value, setValue] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const changed = value.trim() !== name;
  return (
    <form
      className="flex items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!changed) return;
        start(async () => {
          setError(null);
          const result = await renameSourceAction(id, value);
          if (result?.message) setError(result.message);
          else toast.success("Name saved");
        });
      }}
    >
      <TextField
        className="flex-1"
        value={value}
        onChange={(next) => {
          setValue(next);
          setError(null);
        }}
        isInvalid={Boolean(error)}
      >
        <Label>Name</Label>
        <Input autoComplete="off" />
        {error ? <p className="text-small text-danger">{error}</p> : null}
      </TextField>
      <Button type="submit" variant="outline" isDisabled={!changed} isPending={pending}>
        Save name
      </Button>
    </form>
  );
}

/** Danger zone: disable (no queries, syncs or checks until enabled again) and delete. */
export function SourceDangerZone({
  source,
}: {
  source: { id: string; name: string; sample: boolean; disabled: boolean };
}) {
  const [pending, start] = useTransition();
  const [deleting, setDeleting] = useState(false);
  return (
    <div className="flex flex-col divide-y divide-border rounded-2xl border border-danger-soft">
      <div className="flex items-center gap-4 px-4 py-3">
        <div className="flex flex-1 flex-col gap-0.5">
          <span className="text-body font-medium">
            {source.disabled ? "Enable this source" : "Disable this source"}
          </span>
          <span className="text-small text-muted">
            {source.disabled
              ? "OpenDash can query, check and sync it again."
              : "OpenDash stops querying, checking and syncing it. What it learned is kept."}
          </span>
        </div>
        <Button
          variant="outline"
          isPending={pending}
          onPress={() =>
            start(async () => {
              const result = await setSourceDisabledAction(source.id, !source.disabled);
              if (result?.message) toast.danger(result.message);
            })
          }
        >
          {source.disabled ? "Enable" : "Disable"}
        </Button>
      </div>
      <div className="flex items-center gap-4 px-4 py-3">
        <div className="flex flex-1 flex-col gap-0.5">
          <span className="text-body font-medium">{source.sample ? "Remove sample data" : "Delete this source"}</span>
          <span className="text-small text-muted">
            Removes the connection, what OpenDash learned and the saved password. Answers in threads keep their numbers.
          </span>
        </div>
        <Button variant="danger-soft" onPress={() => setDeleting(true)}>
          {source.sample ? "Remove" : "Delete"}
        </Button>
      </div>
      <DeleteSourceDialog
        id={source.id}
        name={source.name}
        sample={source.sample}
        isOpen={deleting}
        onOpenChange={setDeleting}
      />
    </div>
  );
}

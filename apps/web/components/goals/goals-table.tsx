"use client";

import { AlertDialog, Button, Dropdown, Label, Meter, toast } from "@heroui/react";
import { DataTable, dataColumns, useDataTable } from "@opendash/ui";
import { Ellipsis, Pencil, Target, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { deleteGoalAction } from "@/app/(app)/settings/goals/actions";
import { GoalDialog, type GoalDraft, type GoalMetric } from "./goal-dialog";

/** A goal as the goals list shows it: formatted on the server (its metric's own format), with how it stands. */
export interface GoalRow {
  id: string;
  title: string;
  metric: string;
  target: string;
  due: string;
  standing: string;
  time: string;
  bar: number;
  tone: "success" | "accent" | "warning";
  draft: GoalDraft;
}

const col = dataColumns<GoalRow & { admin: boolean; edit: (g: GoalDraft) => void; remove: (id: string) => void }>();
const columns = col.columns([
  col.accessor("title", {
    header: "Goal",
    meta: { rowHeader: true, className: "w-full" },
    cell: ({ row: { original: g } }) => (
      <span className="flex min-w-0 items-center gap-2.5">
        <Target className="size-4 shrink-0 text-muted" aria-hidden />
        <span className="truncate font-medium">{g.title}</span>
      </span>
    ),
  }),
  col.accessor("metric", {
    header: "Metric",
    meta: { className: "hidden whitespace-nowrap text-muted @4xl/page:table-cell" },
  }),
  col.accessor("target", { header: "Target", meta: { align: "end", className: "whitespace-nowrap tabular-nums" } }),
  col.accessor("due", { header: "Due", meta: { className: "whitespace-nowrap text-muted" } }),
  col.accessor("standing", {
    header: "Now",
    meta: { className: "hidden min-w-44 @2xl/page:table-cell" },
    cell: ({ row: { original: g } }) => (
      <span className="flex flex-col gap-1">
        <span className="text-small text-muted">
          {g.standing} · {g.time}
        </span>
        <Meter value={g.bar * 100} color={g.tone} size="sm" aria-label={g.standing}>
          <Meter.Track>
            <Meter.Fill />
          </Meter.Track>
        </Meter>
      </span>
    ),
  }),
  col.display({
    id: "actions",
    header: () => <span className="sr-only">Actions</span>,
    meta: { align: "end" },
    cell: ({ row: { original: g } }) =>
      g.admin ? (
        <Dropdown>
          <Button isIconOnly size="sm" variant="ghost" aria-label={`Actions for ${g.title}`}>
            <Ellipsis className="size-4" aria-hidden />
          </Button>
          <Dropdown.Popover placement="bottom end" className="min-w-40">
            <Dropdown.Menu onAction={(key) => (key === "edit" ? g.edit(g.draft) : g.remove(g.id))}>
              <Dropdown.Item id="edit" textValue="Change">
                <Pencil className="size-4 text-muted" aria-hidden />
                <Label>Change</Label>
              </Dropdown.Item>
              <Dropdown.Item id="remove" textValue="Remove" variant="danger">
                <Trash2 className="size-4" aria-hidden />
                <Label>Remove</Label>
              </Dropdown.Item>
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
      ) : null,
  }),
]);

/** The goals, and for owners and admins, New goal, Change and Remove. */
export function GoalsTable({
  goals,
  metrics,
  admin,
  today,
}: {
  goals: GoalRow[];
  metrics: GoalMetric[];
  admin: boolean;
  today: string;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<GoalDraft | null>(null);
  // Remove asks first, like every delete: a goal has no draft to go back to.
  const [removing, setRemoving] = useState<GoalRow | null>(null);
  const [pending, setPending] = useState(false);
  const remove = useCallback((id: string) => setRemoving(goals.find((g) => g.id === id) ?? null), [goals]);
  const confirmRemove = async () => {
    if (!removing) return;
    setPending(true);
    const r = await deleteGoalAction(removing.id);
    setPending(false);
    setRemoving(null);
    if (!r.ok) toast.danger(r.message);
    else toast.success("Goal removed.");
    router.refresh();
  };
  const data = useMemo(() => goals.map((g) => ({ ...g, admin, edit: setEditing, remove })), [goals, admin, remove]);
  const table = useDataTable({ columns, data, getRowId: (g) => g.id });
  return (
    <>
      <DataTable table={table} label="Goals" footer={`${goals.length} ${goals.length === 1 ? "goal" : "goals"}`} />
      <AlertDialog>
        <AlertDialog.Backdrop isOpen={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
          <AlertDialog.Container>
            <AlertDialog.Dialog>
              <AlertDialog.Header>
                <AlertDialog.Heading>Remove “{removing?.title}”?</AlertDialog.Heading>
              </AlertDialog.Header>
              <AlertDialog.Body>
                <p className="text-body text-muted">It leaves Home at once. Its metric isn't touched.</p>
              </AlertDialog.Body>
              <AlertDialog.Footer>
                <Button variant="ghost" slot="close">
                  Cancel
                </Button>
                <Button variant="danger" isPending={pending} onPress={confirmRemove}>
                  Remove goal
                </Button>
              </AlertDialog.Footer>
            </AlertDialog.Dialog>
          </AlertDialog.Container>
        </AlertDialog.Backdrop>
      </AlertDialog>
      {editing ? (
        <GoalDialog
          key={editing.id}
          isOpen
          onOpenChange={(open) => !open && setEditing(null)}
          metrics={metrics}
          goal={editing}
          today={today}
        />
      ) : null}
    </>
  );
}

/** The goals list's New goal button and its dialog. */
export function NewGoal({ metrics, today }: { metrics: GoalMetric[]; today: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" onPress={() => setOpen(true)} isDisabled={!metrics.length}>
        <Target className="size-3.5" aria-hidden />
        New goal
      </Button>
      {open ? <GoalDialog isOpen onOpenChange={setOpen} metrics={metrics} today={today} /> : null}
    </>
  );
}

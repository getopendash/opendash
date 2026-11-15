"use client";

import {
  Button,
  Input,
  Label,
  ListBox,
  Modal,
  Select,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  toast,
} from "@heroui/react";
import type { InsightView } from "@opendash/core";
import { ArrowDownRight, ArrowUpRight, ListChecks, Radar } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { createTaskAction } from "@/app/(app)/tasks/actions";
import { defaultTaskTitle, HORIZON_LABEL } from "@/lib/task-words";

/**
 * A task from an insight. Which way it should move the metric defaults to the metric's better direction; done,
 * it's judged over the whole months after it against the metric's own trend.
 */
export function CreateTaskDialog({
  insight,
  isOpen,
  onOpenChange,
  today,
}: {
  insight: InsightView;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  today: string;
}) {
  const router = useRouter();
  // An anomaly's or a trend's metric (the same shape), or a goal's.
  const c = insight.claims ?? insight.trend;
  const goal = insight.goalRisk;
  // A goal says which way; an anomaly's or a trend's metric says which way is better.
  const better: "up" | "down" = goal
    ? goal.goal.direction === "at_most"
      ? "down"
      : "up"
    : c?.metric.direction === "lower_is_better"
      ? "down"
      : "up";
  const [title, setTitle] = useState(defaultTaskTitle(insight.title));
  const [direction, setDirection] = useState<"up" | "down">(better);
  const [horizon, setHorizon] = useState(2);
  const [due, setDue] = useState("");
  const [pending, setPending] = useState(false);
  const save = async () => {
    setPending(true);
    const r = await createTaskAction({
      insightId: insight.id,
      title,
      direction,
      horizonMonths: horizon,
      dueAt: due || null,
    });
    setPending(false);
    if (!r.ok) {
      toast.danger(r.message);
      return;
    }
    toast.success("Task created. It's in Tasks.");
    onOpenChange(false);
    router.refresh();
  };
  const metric = c?.metric.title ?? goal?.metric.title ?? "its metric";
  return (
    <Modal>
      <Modal.Backdrop isOpen={isOpen} onOpenChange={onOpenChange}>
        <Modal.Container size="md">
          <Modal.Dialog>
            <Modal.Header>
              <Modal.Heading>Create a task</Modal.Heading>
            </Modal.Header>
            <Modal.Body className="flex flex-col gap-4">
              <p className="flex items-center gap-2 rounded-xl bg-surface-secondary px-2.5 py-2 text-small font-medium">
                <Radar className="size-3.5 shrink-0 text-muted-tertiary" aria-hidden />
                {insight.title}
              </p>
              <TextField value={title} onChange={setTitle} className="flex flex-col gap-1.5">
                <Label>What to do</Label>
                <Input maxLength={160} />
              </TextField>
              <div className="flex flex-col gap-1.5">
                <span className="text-small font-medium">It should move {metric}</span>
                <ToggleButtonGroup
                  aria-label={`Which way it should move ${metric}`}
                  selectionMode="single"
                  disallowEmptySelection
                  selectedKeys={new Set([direction])}
                  onSelectionChange={(keys) => setDirection(([...keys][0] as "up" | "down") ?? better)}
                  size="sm"
                  className="w-fit"
                >
                  <ToggleButton id="up">
                    <ArrowUpRight className="size-3.5" aria-hidden />
                    Up
                  </ToggleButton>
                  <ToggleButton id="down">
                    <ToggleButtonGroup.Separator />
                    <ArrowDownRight className="size-3.5" aria-hidden />
                    Down
                  </ToggleButton>
                </ToggleButtonGroup>
                {c && c.metric.direction !== "neutral" ? (
                  <span className="text-small text-muted-tertiary">
                    {metric} is better {c.metric.direction === "higher_is_better" ? "higher" : "lower"}.
                  </span>
                ) : null}
              </div>
              <Select
                value={String(horizon)}
                onChange={(key) => setHorizon(Number(key ?? 2))}
                className="flex flex-col gap-1.5"
              >
                <Label>Judge it over</Label>
                <Select.Trigger>
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover>
                  <ListBox>
                    {Object.entries(HORIZON_LABEL).map(([months, label]) => (
                      <ListBox.Item key={months} id={months} textValue={label}>
                        {label}
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                    ))}
                  </ListBox>
                </Select.Popover>
                <span className="text-small text-muted-tertiary">
                  When it's done, OpenDash compares those months with what {metric} would have done on its trend. No AI
                  is involved.
                </span>
              </Select>
              <TextField value={due} onChange={setDue} className="flex flex-col gap-1.5">
                <Label>Due (optional)</Label>
                <Input type="date" min={today} className="w-48" />
              </TextField>
            </Modal.Body>
            <Modal.Footer className="flex justify-end gap-2">
              <Button variant="ghost" slot="close">
                Cancel
              </Button>
              <Button isPending={pending} isDisabled={!title.trim()} onPress={save}>
                <ListChecks className="size-3.5" aria-hidden />
                Create task
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}

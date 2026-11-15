"use client";

import { Button, Input, Label, ListBox, Modal, Select, TextField, toast } from "@heroui/react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { saveGoalAction } from "@/app/(app)/settings/goals/actions";

export interface GoalMetric {
  id: string;
  title: string;
  direction: "higher_is_better" | "lower_is_better" | "neutral";
}

export interface GoalDraft {
  id: string;
  metricId: string;
  target: number;
  due: string;
  direction: "at_least" | "at_most";
}

const DAY = 86_400_000;

/** A goal on a verified metric, its target and its due day. The direction is the metric's unless it's neutral. */
export function GoalDialog({
  isOpen,
  onOpenChange,
  metrics,
  goal,
  today,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  metrics: GoalMetric[];
  /** The goal being changed; absent for a new one. */
  goal?: GoalDraft;
  /** Today, YYYY-MM-DD (UTC), from the server. */
  today: string;
}) {
  const router = useRouter();
  const [metricId, setMetricId] = useState(goal?.metricId ?? metrics[0]?.id ?? "");
  const [target, setTarget] = useState(goal ? String(goal.target) : "");
  const [due, setDue] = useState(goal?.due ?? "");
  const [chosen, setChosen] = useState<"at_least" | "at_most">(goal?.direction ?? "at_least");
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const metric = metrics.find((m) => m.id === metricId);
  const direction =
    metric?.direction === "higher_is_better"
      ? "at_least"
      : metric?.direction === "lower_is_better"
        ? "at_most"
        : chosen;
  const value = Number(target.replace(/[,\s$]/g, ""));
  const days = due ? Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY) : null;

  async function save() {
    setPending(true);
    setProblem(null);
    const r = await saveGoalAction({
      ...(goal ? { id: goal.id } : {}),
      metricId,
      target: value,
      due,
      ...(metric?.direction === "neutral" ? { direction } : {}),
    });
    setPending(false);
    if (!r.ok) return void setProblem(r.message);
    onOpenChange(false);
    toast.success(goal ? "Goal changed." : "Goal set: Home shows how it stands.");
    router.refresh();
  }

  return (
    <Modal>
      <Modal.Backdrop isOpen={isOpen} onOpenChange={onOpenChange}>
        <Modal.Container size="md">
          <Modal.Dialog>
            <Modal.Header className="flex flex-col gap-1">
              <Modal.Heading>{goal ? "Change the goal" : "New goal"}</Modal.Heading>
              <p className="text-body text-muted">
                On a verified metric. Home shows how it stands, as of the metric's last test.
              </p>
            </Modal.Header>
            <Modal.Body className="flex flex-col gap-4">
              <Select
                value={metricId}
                onChange={(key) => setMetricId(String(key ?? ""))}
                className="flex flex-col gap-1.5"
              >
                <Label>Metric</Label>
                <Select.Trigger>
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover>
                  <ListBox>
                    {metrics.map((m) => (
                      <ListBox.Item key={m.id} id={m.id} textValue={m.title}>
                        {m.title}
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                    ))}
                  </ListBox>
                </Select.Popover>
              </Select>
              {metric?.direction === "neutral" ? (
                <Select
                  value={chosen}
                  onChange={(key) => setChosen(key === "at_most" ? "at_most" : "at_least")}
                  className="flex flex-col gap-1.5"
                >
                  <Label>The goal is to</Label>
                  <Select.Trigger>
                    <Select.Value />
                    <Select.Indicator />
                  </Select.Trigger>
                  <Select.Popover>
                    <ListBox>
                      <ListBox.Item id="at_least" textValue="Reach at least the target">
                        Reach at least the target
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                      <ListBox.Item id="at_most" textValue="Stay at most at the target">
                        Stay at most at the target
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                    </ListBox>
                  </Select.Popover>
                </Select>
              ) : null}
              <TextField value={target} onChange={setTarget} className="flex flex-col gap-1.5">
                <Label>Target</Label>
                <Input inputMode="decimal" placeholder="500000" />
                {metric ? (
                  <span className="text-small text-muted">
                    {metric.direction === "neutral"
                      ? "Say which way the goal goes: this metric has no better direction."
                      : `${metric.title} is better ${metric.direction === "higher_is_better" ? "higher" : "lower"}: the goal is to ${direction === "at_least" ? "reach at least" : "stay at most at"} the target.`}
                  </span>
                ) : null}
              </TextField>
              <TextField value={due} onChange={setDue} className="flex flex-col gap-1.5">
                <Label>Due</Label>
                <Input type="date" min={goal ? undefined : today} />
                {days !== null && Number.isFinite(days) ? (
                  <span className="text-small text-muted">
                    {days > 1
                      ? `${days} days from today.`
                      : days === 1
                        ? "Tomorrow."
                        : days === 0
                          ? "Today."
                          : "Already passed."}
                  </span>
                ) : null}
              </TextField>
              {problem ? <p className="text-small text-danger">{problem}</p> : null}
            </Modal.Body>
            <Modal.Footer className="flex justify-end gap-2">
              <Button variant="ghost" slot="close">
                Cancel
              </Button>
              <Button
                isPending={pending}
                isDisabled={!metric || !target.trim() || !Number.isFinite(value) || !due}
                onPress={save}
              >
                {goal ? "Save" : "Save goal"}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}

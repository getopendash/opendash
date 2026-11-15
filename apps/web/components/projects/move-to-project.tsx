"use client";

import { Button, Checkbox, Label, ListBox, Modal, Select, toast } from "@heroui/react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { moveToProjectAction } from "@/app/(app)/projects/actions";

/** A project this person can see, and whether they can add to it (its editors and managers). */
export interface ProjectChoice {
  id: string;
  name: string;
  canAdd: boolean;
}

const OUT = "none";

/**
 * Moves the owner's conversation or dashboard into a project, shared with its people when they say so, or out
 * of its project. Opened from the item's menu; `onMoved` refreshes what shows it.
 */
export function MoveToProject({
  item,
  title,
  current,
  projects,
  isOpen,
  onOpenChange,
  onMoved,
}: {
  item: { kind: "thread" | "dashboard"; id: string };
  title: string;
  current: string | null;
  projects: ProjectChoice[];
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onMoved?: () => void;
}) {
  const router = useRouter();
  const targets = projects.filter((p) => p.canAdd && p.id !== current);
  const [target, setTarget] = useState<string>(targets[0]?.id ?? OUT);
  const [share, setShare] = useState(true);
  const [pending, setPending] = useState(false);
  const into = target !== OUT;

  async function move() {
    setPending(true);
    const r = await moveToProjectAction(item, into ? target : null, into && share);
    setPending(false);
    if (!r.ok) return void toast.danger(r.message);
    onOpenChange(false);
    toast.success(into ? `Moved to ${projects.find((p) => p.id === target)?.name}.` : "Moved out of the project.");
    onMoved?.();
    router.refresh();
  }

  return (
    <Modal>
      <Modal.Backdrop isOpen={isOpen} onOpenChange={onOpenChange}>
        <Modal.Container size="md">
          <Modal.Dialog>
            <Modal.Header className="flex flex-col gap-1">
              <Modal.Heading>{current ? "Move to another project" : "Move to a project"}</Modal.Heading>
              <p className="text-body text-muted">“{title}” stays yours. In a project, its people can find it.</p>
            </Modal.Header>
            <Modal.Body className="flex flex-col gap-4">
              {targets.length || current ? (
                <Select
                  value={target}
                  onChange={(key) => setTarget(String(key ?? OUT))}
                  className="flex flex-col gap-1.5"
                >
                  <Label>Project</Label>
                  <Select.Trigger>
                    <Select.Value />
                    <Select.Indicator />
                  </Select.Trigger>
                  <Select.Popover>
                    <ListBox>
                      {targets.map((p) => (
                        <ListBox.Item key={p.id} id={p.id} textValue={p.name}>
                          {p.name}
                          <ListBox.ItemIndicator />
                        </ListBox.Item>
                      ))}
                      {current ? (
                        <ListBox.Item id={OUT} textValue="No project">
                          No project (move it out)
                          <ListBox.ItemIndicator />
                        </ListBox.Item>
                      ) : null}
                    </ListBox>
                  </Select.Popover>
                </Select>
              ) : (
                <p className="text-body text-muted">
                  You aren't an editor in any project yet. Create one, or ask a project's manager to add you.
                </p>
              )}
              {into ? (
                <Checkbox isSelected={share} onChange={setShare}>
                  <Checkbox.Content>
                    <Checkbox.Control>
                      <Checkbox.Indicator />
                    </Checkbox.Control>
                    Share it with the project's people
                  </Checkbox.Content>
                </Checkbox>
              ) : null}
            </Modal.Body>
            <Modal.Footer className="flex justify-end gap-2">
              <Button variant="ghost" slot="close">
                Cancel
              </Button>
              <Button isPending={pending} isDisabled={!targets.length && !current} onPress={move}>
                Move
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}

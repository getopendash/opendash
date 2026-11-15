"use client";

import { Button, Description, Input, Label, Modal, Radio, RadioGroup, TextField, toast } from "@heroui/react";
import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { createProjectAction } from "@/app/(app)/projects/actions";

/** A new project, then its page. */
export function NewProject({ org }: { org: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<"private" | "org">("private");
  const [pending, setPending] = useState(false);

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setPending(true);
    const r = await createProjectAction({ name, description, visibility });
    setPending(false);
    if (!r.ok) return void toast.danger(r.message);
    setOpen(false);
    router.push(`/projects/${r.id}`);
  }

  return (
    <>
      <Button size="sm" onPress={() => setOpen(true)}>
        <Plus className="size-3.5" aria-hidden />
        New project
      </Button>
      <Modal>
        <Modal.Backdrop isOpen={open} onOpenChange={setOpen}>
          <Modal.Container size="md">
            <Modal.Dialog>
              <form onSubmit={create}>
                <Modal.Header className="flex flex-col gap-1">
                  <Modal.Heading>New project</Modal.Heading>
                  <p className="text-body text-muted">
                    A place for a piece of work: its conversations and dashboards, shared with the people on it.
                  </p>
                </Modal.Header>
                <Modal.Body className="flex flex-col gap-4">
                  <TextField value={name} onChange={setName} className="flex flex-col gap-1.5" autoFocus>
                    <Label>Name</Label>
                    <Input maxLength={80} placeholder="Board pack" />
                  </TextField>
                  <TextField value={description} onChange={setDescription} className="flex flex-col gap-1.5">
                    <Label>Description (optional)</Label>
                    <Input maxLength={200} placeholder="Monthly numbers for the board" />
                  </TextField>
                  <RadioGroup
                    value={visibility}
                    onChange={(v) => setVisibility(v === "org" ? "org" : "private")}
                    className="flex flex-col gap-1"
                  >
                    <Label>Who can open it</Label>
                    {[
                      {
                        value: "private",
                        label: "People you add",
                        description: "You add people and choose what they can do. Admins see it too.",
                      },
                      {
                        value: "org",
                        label: `Everyone at ${org}`,
                        description: "Everyone can open it and read what's shared with it. Only its people add to it.",
                      },
                    ].map((o) => (
                      <Radio
                        key={o.value}
                        value={o.value}
                        className="mt-0 rounded-xl px-2.5 py-2 data-selected:bg-default"
                      >
                        <Radio.Content className="flex items-center gap-2.5 text-body">
                          <Radio.Control>
                            <Radio.Indicator />
                          </Radio.Control>
                          {o.label}
                        </Radio.Content>
                        <Description className="pl-7 text-small text-muted">{o.description}</Description>
                      </Radio>
                    ))}
                  </RadioGroup>
                </Modal.Body>
                <Modal.Footer className="flex justify-end gap-2">
                  <Button variant="ghost" slot="close">
                    Cancel
                  </Button>
                  <Button type="submit" isPending={pending} isDisabled={!name.trim()}>
                    Create project
                  </Button>
                </Modal.Footer>
              </form>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </>
  );
}

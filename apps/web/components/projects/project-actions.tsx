"use client";

import {
  Button,
  buttonVariants,
  Dropdown,
  Input,
  Label,
  ListBox,
  Modal,
  Select,
  TextField,
  toast,
} from "@heroui/react";
import type { ProjectRole } from "@opendash/core";
import { Ellipsis, Globe, Lock, Pencil, SquarePen, Trash2, Users, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import {
  deleteProjectAction,
  removeProjectPersonAction,
  setProjectPersonAction,
  updateProjectAction,
} from "@/app/(app)/projects/actions";

export interface Person {
  userId: string;
  name: string;
  email: string;
  role: ProjectRole;
}

export interface OrgMember {
  userId: string;
  name: string;
  email: string;
  /** Their organization role: its viewers are only ever viewers in a project. */
  orgRole: string;
}

const ROLES: { id: ProjectRole; label: string }[] = [
  { id: "manager", label: "Manager" },
  { id: "editor", label: "Editor" },
  { id: "viewer", label: "Viewer" },
];

function RoleSelect({
  value,
  onChange,
  viewerOnly,
  label,
}: {
  value: ProjectRole;
  onChange: (role: ProjectRole) => void;
  viewerOnly: boolean;
  label: string;
}) {
  return (
    <Select
      aria-label={label}
      value={value}
      onChange={(key) => onChange((key as ProjectRole) ?? value)}
      disabledKeys={viewerOnly ? ["manager", "editor"] : []}
      className="w-32"
    >
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          {ROLES.map((r) => (
            <ListBox.Item key={r.id} id={r.id} textValue={r.label}>
              {r.label}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}

/** The project's people. Managers add, change and remove them; anyone can leave. */
function PeopleDialog({
  project,
  people,
  members,
  me,
  manages,
  isOpen,
  onOpenChange,
}: {
  project: { id: string; name: string };
  people: Person[];
  members: OrgMember[];
  me: string;
  manages: boolean;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [adding, setAdding] = useState<string | null>(null);
  const [role, setRole] = useState<ProjectRole>("editor");
  const [pending, setPending] = useState(false);
  const inProject = new Set(people.map((p) => p.userId));
  const candidates = members.filter((m) => !inProject.has(m.userId));
  const addingMember = candidates.find((m) => m.userId === adding);

  const act = async (work: () => Promise<{ ok: boolean; message?: string }>, done?: string) => {
    setPending(true);
    const r = await work();
    setPending(false);
    if (!r.ok) return void toast.danger((r as { message: string }).message);
    if (done) toast.success(done);
    router.refresh();
  };

  return (
    <Modal>
      <Modal.Backdrop isOpen={isOpen} onOpenChange={onOpenChange}>
        <Modal.Container size="md">
          <Modal.Dialog>
            <Modal.Header className="flex flex-col gap-1">
              <Modal.Heading>People in {project.name}</Modal.Heading>
              <p className="text-body text-muted">
                Managers change the project and its people. Editors start conversations in it and move their own things
                in. Viewers read what's shared with it.
              </p>
            </Modal.Header>
            <Modal.Body className="flex flex-col gap-4">
              {manages && candidates.length ? (
                <div className="flex flex-wrap items-end gap-2">
                  <Select
                    value={adding}
                    onChange={(key) => {
                      const m = candidates.find((c) => c.userId === key);
                      setAdding(m ? m.userId : null);
                      if (m?.orgRole === "viewer") setRole("viewer");
                    }}
                    className="flex min-w-48 flex-1 flex-col gap-1.5"
                    placeholder="Choose someone"
                  >
                    <Label>Add someone</Label>
                    <Select.Trigger>
                      <Select.Value />
                      <Select.Indicator />
                    </Select.Trigger>
                    <Select.Popover>
                      <ListBox>
                        {candidates.map((m) => (
                          <ListBox.Item key={m.userId} id={m.userId} textValue={m.name || m.email}>
                            {m.name || m.email}
                            <ListBox.ItemIndicator />
                          </ListBox.Item>
                        ))}
                      </ListBox>
                    </Select.Popover>
                  </Select>
                  <RoleSelect
                    label="Their role"
                    value={role}
                    onChange={setRole}
                    viewerOnly={addingMember?.orgRole === "viewer"}
                  />
                  <Button
                    variant="secondary"
                    isPending={pending}
                    isDisabled={!adding}
                    onPress={() =>
                      adding &&
                      act(async () => {
                        const r = await setProjectPersonAction(project.id, adding, role);
                        if (r.ok) setAdding(null);
                        return r;
                      })
                    }
                  >
                    Add
                  </Button>
                </div>
              ) : null}
              <ul className="flex flex-col divide-y divide-border">
                {people.map((p) => {
                  const member = members.find((m) => m.userId === p.userId);
                  return (
                    <li key={p.userId} className="flex items-center gap-3 py-2.5">
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-body">{p.userId === me ? `${p.name} (you)` : p.name}</span>
                        <span className="truncate text-small text-muted-tertiary">{p.email}</span>
                      </span>
                      {manages ? (
                        <RoleSelect
                          label={`${p.name}'s role`}
                          value={p.role}
                          viewerOnly={member?.orgRole === "viewer"}
                          onChange={(next) =>
                            next !== p.role && act(() => setProjectPersonAction(project.id, p.userId, next))
                          }
                        />
                      ) : (
                        <span className="text-small text-muted">{ROLES.find((r) => r.id === p.role)?.label}</span>
                      )}
                      {manages || p.userId === me ? (
                        <Button
                          isIconOnly
                          size="sm"
                          variant="ghost"
                          aria-label={p.userId === me ? "Leave the project" : `Remove ${p.name}`}
                          onPress={() =>
                            act(
                              () => removeProjectPersonAction(project.id, p.userId),
                              p.userId === me ? `You left ${project.name}.` : undefined,
                            )
                          }
                        >
                          <X className="size-3.5" />
                        </Button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </Modal.Body>
            <Modal.Footer className="flex justify-end">
              <Button slot="close">Done</Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}

/** A project's top bar: People, New question (its editors and managers), and the managers' menu. */
export function ProjectActions({
  project,
  org,
  people,
  members,
  me,
  canAdd,
  manages,
}: {
  project: { id: string; name: string; description: string | null; visibility: "private" | "org" };
  org: string;
  people: Person[];
  members: OrgMember[];
  me: string;
  canAdd: boolean;
  manages: boolean;
}) {
  const router = useRouter();
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? "");
  const [pending, setPending] = useState(false);

  const save = async (input: Parameters<typeof updateProjectAction>[1], done?: string) => {
    setPending(true);
    const r = await updateProjectAction(project.id, input);
    setPending(false);
    if (!r.ok) return void toast.danger(r.message);
    if (done) toast.success(done);
    setRenaming(false);
    router.refresh();
  };

  return (
    <span className="flex items-center gap-2">
      <Button size="sm" variant="secondary" onPress={() => setPeopleOpen(true)}>
        <Users className="size-3.5" aria-hidden />
        People
      </Button>
      {canAdd ? (
        <Link href={`/ask/new?project=${project.id}`} className={buttonVariants({ size: "sm" })}>
          <SquarePen className="size-3.5" aria-hidden />
          New question
        </Link>
      ) : null}
      {manages ? (
        <Dropdown>
          <Button isIconOnly size="sm" variant="ghost" aria-label="Project actions">
            <Ellipsis className="size-4" aria-hidden />
          </Button>
          <Dropdown.Popover placement="bottom end" className="min-w-56">
            <Dropdown.Menu
              onAction={(key) => {
                if (key === "rename") setRenaming(true);
                else if (key === "visibility")
                  void save(
                    { visibility: project.visibility === "org" ? "private" : "org" },
                    project.visibility === "org"
                      ? "Only its people can open it now."
                      : `Everyone at ${org} can open it now.`,
                  );
                else if (key === "delete") setDeleting(true);
              }}
            >
              <Dropdown.Item id="rename" textValue="Rename">
                <Pencil className="size-4 text-muted" aria-hidden />
                <Label>Rename</Label>
              </Dropdown.Item>
              <Dropdown.Item id="visibility" textValue="Who can open it">
                {project.visibility === "org" ? (
                  <Lock className="size-4 text-muted" aria-hidden />
                ) : (
                  <Globe className="size-4 text-muted" aria-hidden />
                )}
                <Label>{project.visibility === "org" ? "Make it people only" : `Open to everyone at ${org}`}</Label>
              </Dropdown.Item>
              <Dropdown.Item id="delete" textValue="Delete project" variant="danger">
                <Trash2 className="size-4" aria-hidden />
                <Label>Delete project</Label>
              </Dropdown.Item>
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
      ) : null}

      <PeopleDialog
        project={project}
        people={people}
        members={members}
        me={me}
        manages={manages}
        isOpen={peopleOpen}
        onOpenChange={setPeopleOpen}
      />

      <Modal>
        <Modal.Backdrop isOpen={renaming} onOpenChange={setRenaming}>
          <Modal.Container size="md">
            <Modal.Dialog>
              <form
                onSubmit={(e: FormEvent) => {
                  e.preventDefault();
                  void save({ name, description: description || null });
                }}
              >
                <Modal.Header>
                  <Modal.Heading>Rename {project.name}</Modal.Heading>
                </Modal.Header>
                <Modal.Body className="flex flex-col gap-4">
                  <TextField value={name} onChange={setName} className="flex flex-col gap-1.5" autoFocus>
                    <Label>Name</Label>
                    <Input maxLength={80} />
                  </TextField>
                  <TextField value={description} onChange={setDescription} className="flex flex-col gap-1.5">
                    <Label>Description (optional)</Label>
                    <Input maxLength={200} />
                  </TextField>
                </Modal.Body>
                <Modal.Footer className="flex justify-end gap-2">
                  <Button variant="ghost" slot="close">
                    Cancel
                  </Button>
                  <Button type="submit" isPending={pending} isDisabled={!name.trim()}>
                    Save
                  </Button>
                </Modal.Footer>
              </form>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>

      <Modal>
        <Modal.Backdrop isOpen={deleting} onOpenChange={setDeleting}>
          <Modal.Container size="md">
            <Modal.Dialog>
              <Modal.Header className="flex flex-col gap-1">
                <Modal.Heading>Delete {project.name}?</Modal.Heading>
                <p className="text-body text-muted">
                  Its conversations and dashboards stay with their owners, out of any project. What was shared with the
                  project becomes private; what was shared with everyone stays shared.
                </p>
              </Modal.Header>
              <Modal.Footer className="flex justify-end gap-2">
                <Button variant="ghost" slot="close">
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  isPending={pending}
                  onPress={async () => {
                    setPending(true);
                    const r = await deleteProjectAction(project.id);
                    setPending(false);
                    if (!r.ok) return void toast.danger(r.message);
                    setDeleting(false);
                    toast.success(`Deleted ${project.name}.`);
                    router.push("/projects");
                  }}
                >
                  Delete project
                </Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </span>
  );
}

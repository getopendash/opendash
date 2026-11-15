"use client";

import { Button, Dropdown, Input, Label, Modal, TextField, toast } from "@heroui/react";
import type { FolderView } from "@opendash/core";
import { Ellipsis, Folder, FolderInput, FolderPlus, Layers, Pencil, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  createFolderAction,
  deleteFolderAction,
  moveToFolderAction,
  renameFolderAction,
} from "@/app/(app)/projects/folder-actions";

/** Which folder the project page shows: all of it, one folder, or what's in none. */
export type FolderScope = "all" | "none" | string;

const href = (projectId: string, scope: FolderScope) =>
  scope === "all" ? `/projects/${projectId}` : `/projects/${projectId}?folder=${scope}`;

/** A project's folders as filters, with New folder, and renaming or deleting the one shown (its editors). */
export function FolderStrip({
  projectId,
  folders,
  scope,
  counts,
  canEdit,
}: {
  projectId: string;
  folders: FolderView[];
  scope: FolderScope;
  /** What the viewer can read in all of the project, and in no folder. */
  counts: { all: number; none: number };
  canEdit: boolean;
}) {
  const router = useRouter();
  const [naming, setNaming] = useState<{ id: string | null; name: string } | null>(null);
  const [pending, setPending] = useState(false);
  const active = folders.find((f) => f.id === scope) ?? null;
  const pill = (to: FolderScope, label: string, count: number, icon: "all" | "folder") => (
    <Link
      key={to}
      href={href(projectId, to)}
      aria-current={scope === to ? "page" : undefined}
      className={`flex h-7 items-center gap-1.5 rounded-lg border border-border px-2.5 text-small ${scope === to ? "bg-default font-medium text-foreground" : "text-muted hover:text-foreground"}`}
    >
      {icon === "all" ? <Layers className="size-3.5" aria-hidden /> : <Folder className="size-3.5" aria-hidden />}
      {label}
      <span className="text-muted-tertiary">{count}</span>
    </Link>
  );
  const save = async () => {
    if (!naming) return;
    setPending(true);
    if (naming.id) {
      const r = await renameFolderAction(projectId, naming.id, naming.name);
      setPending(false);
      if (!r.ok) return void toast.danger(r.message);
      setNaming(null);
      return void router.refresh();
    }
    const r = await createFolderAction(projectId, naming.name);
    setPending(false);
    if (!r.ok) return void toast.danger(r.message);
    setNaming(null);
    router.push(href(projectId, r.folder.id));
  };
  const remove = async (id: string) => {
    const r = await deleteFolderAction(projectId, id);
    if (!r.ok) return void toast.danger(r.message);
    toast.success("Folder deleted. What was in it stays in the project.");
    router.push(href(projectId, "all"));
  };
  if (!folders.length && !canEdit) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {pill("all", "All", counts.all, "all")}
      {folders.map((f) => pill(f.id, f.name, f.conversations + f.dashboards, "folder"))}
      {folders.length ? pill("none", "Not in a folder", counts.none, "folder") : null}
      {active && canEdit ? (
        <Dropdown>
          <Button isIconOnly size="sm" variant="ghost" aria-label={`Actions for the folder ${active.name}`}>
            <Ellipsis className="size-4" aria-hidden />
          </Button>
          <Dropdown.Popover placement="bottom start" className="min-w-44">
            <Dropdown.Menu
              onAction={(key) =>
                key === "rename" ? setNaming({ id: active.id, name: active.name }) : remove(active.id)
              }
            >
              <Dropdown.Item id="rename" textValue="Rename">
                <Pencil className="size-4 text-muted" aria-hidden />
                <Label>Rename</Label>
              </Dropdown.Item>
              <Dropdown.Item id="delete" textValue="Delete folder" variant="danger">
                <Trash2 className="size-4" aria-hidden />
                <Label>Delete folder</Label>
              </Dropdown.Item>
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
      ) : null}
      <span className="flex-1" />
      {canEdit ? (
        <Button size="sm" variant="ghost" onPress={() => setNaming({ id: null, name: "" })}>
          <FolderPlus className="size-3.5" aria-hidden />
          New folder
        </Button>
      ) : null}
      <Modal>
        <Modal.Backdrop isOpen={naming !== null} onOpenChange={(o) => !o && setNaming(null)}>
          <Modal.Container size="sm">
            <Modal.Dialog>
              <Modal.Header>
                <Modal.Heading>{naming?.id ? "Rename folder" : "New folder"}</Modal.Heading>
              </Modal.Header>
              <Modal.Body>
                <TextField
                  value={naming?.name ?? ""}
                  onChange={(name) => setNaming((n) => (n ? { ...n, name } : n))}
                  autoFocus
                >
                  <Label>Name</Label>
                  <Input maxLength={60} placeholder="Monthly close" />
                </TextField>
              </Modal.Body>
              <Modal.Footer className="flex justify-end gap-2">
                <Button variant="ghost" slot="close">
                  Cancel
                </Button>
                <Button isPending={pending} isDisabled={!naming?.name.trim()} onPress={() => void save()}>
                  {naming?.id ? "Rename" : "Create"}
                </Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </div>
  );
}

/** Move to folder, on a row of its owner's: a folder of the project, or none. */
export function FolderMenu({
  projectId,
  item,
  title,
  folders,
  current,
}: {
  projectId: string;
  item: { kind: "thread" | "dashboard"; id: string };
  title: string;
  folders: FolderView[];
  current: string | null;
}) {
  const router = useRouter();
  const move = async (folderId: string | null) => {
    const r = await moveToFolderAction(projectId, item, folderId);
    if (!r.ok) return void toast.danger(r.message);
    toast.success(folderId ? `Moved to ${folders.find((f) => f.id === folderId)?.name}.` : "Moved out of its folder.");
    router.refresh();
  };
  return (
    <Dropdown>
      <Button isIconOnly size="sm" variant="ghost" aria-label={`Move ${title} to a folder`}>
        <FolderInput className="size-3.5 text-muted" aria-hidden />
      </Button>
      <Dropdown.Popover placement="bottom end" className="min-w-48">
        <Dropdown.Menu
          aria-label="Move to folder"
          disabledKeys={[current ?? "none"]}
          onAction={(key) => void move(key === "none" ? null : String(key))}
        >
          {[
            ...folders.map((f) => (
              <Dropdown.Item key={f.id} id={f.id} textValue={f.name}>
                <Folder className="size-4 text-muted" aria-hidden />
                <Label>{f.name}</Label>
              </Dropdown.Item>
            )),
            <Dropdown.Item key="none" id="none" textValue="Not in a folder">
              <Layers className="size-4 text-muted" aria-hidden />
              <Label>Not in a folder</Label>
            </Dropdown.Item>,
          ]}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}

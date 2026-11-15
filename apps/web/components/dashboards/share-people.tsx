"use client";

import { Button, ListBox, Modal, SearchField, Select, toast } from "@heroui/react";
import { isDefinedError } from "@opendash/api/client";
import { useQuery } from "@tanstack/react-query";
import { UserPlus, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, apiQueries } from "@/lib/api";

type Role = "view" | "edit";
const ROLES: { id: Role; label: string }[] = [
  { id: "view", label: "View" },
  { id: "edit", label: "Can edit" },
];
/** At most this many matches under the search: a name or address narrows it. */
const SHOWN = 6;

/** "3 people", "1 person". */
export const peopleWords = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;

/**
 * Who sees it, in a word on its owner's sharing button: its visibility, or the people it's shared with by name when
 * its visibility keeps it to its owner.
 */
export function seenByWords(visibility: "private" | "project" | "org", people: number): string {
  if (visibility === "private" && people) return peopleWords(people);
  return { private: "Only you", project: "Its project", org: "Everyone" }[visibility];
}

interface Member {
  userId: string;
  name: string;
  email: string;
  viewer: boolean;
}

/**
 * The members a search finds to add: by a part of their name or address, any case, never someone it's shared with
 * already, at most a few; nothing before anything is typed. Each with the role they'd be added with: a workspace
 * viewer only ever to view.
 */
export function peopleToAdd(
  members: Member[],
  added: Set<string>,
  find: string,
  role: Role,
): (Member & { as: Role })[] {
  const q = find.trim().toLowerCase();
  if (!q) return [];
  return members
    .filter((m) => !added.has(m.userId))
    .filter((m) => m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q))
    .slice(0, SHOWN)
    .map((m) => ({ ...m, as: m.viewer ? "view" : role }));
}

function RoleSelect({
  value,
  onChange,
  viewOnly,
  label,
}: {
  value: Role;
  onChange: (role: Role) => void;
  /** A workspace viewer: only ever shared with to view. */
  viewOnly: boolean;
  label: string;
}) {
  return (
    <Select
      aria-label={label}
      value={value}
      onChange={(key) => onChange((key as Role) ?? value)}
      disabledKeys={viewOnly ? ["edit"] : []}
      className="w-28"
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

/**
 * Sharing an App with specific people, its owner's: found among the workspace's members by name or
 * address, each added to view it or to change its draft too (Can edit), changed or removed here. On top of who its
 * visibility covers; publishing, sharing and deleting stay its owner's.
 */
export function SharePeopleDialog({
  dashboard,
  isOpen,
  onOpenChange,
}: {
  dashboard: { id: string; title: string };
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [find, setFind] = useState("");
  const [role, setRole] = useState<Role>("view");
  const [pending, setPending] = useState<string | null>(null);
  const shares = useQuery({
    ...apiQueries.dashboards.shares.queryOptions({ input: { dashboardId: dashboard.id } }),
    enabled: isOpen,
  });
  const people = shares.data?.people ?? [];
  const members = shares.data?.members ?? [];
  const added = new Set(people.map((p) => p.userId));
  const viewers = new Set(members.filter((m) => m.viewer).map((m) => m.userId));
  const q = find.trim();
  const matches = peopleToAdd(members, added, find, role);

  /** Shares it with one person as `next` (null: no longer), saying why when it can't; whether it did. */
  const set = async (userId: string, next: Role | null, done?: string): Promise<boolean> => {
    setPending(userId);
    try {
      await api.dashboards.sharePerson({ dashboardId: dashboard.id, userId, role: next });
      await shares.refetch();
      if (done) toast.success(done);
      // The page's sharing button counts them.
      router.refresh();
      return true;
    } catch (e) {
      toast.danger(isDefinedError(e) ? (e as { message: string }).message : "Couldn't change who it's shared with.");
      return false;
    } finally {
      setPending(null);
    }
  };

  return (
    <Modal>
      <Modal.Backdrop isOpen={isOpen} onOpenChange={onOpenChange}>
        <Modal.Container size="md">
          <Modal.Dialog>
            <Modal.Header className="flex flex-col gap-1">
              <Modal.Heading>Share “{dashboard.title}” with people</Modal.Heading>
              <p className="text-body text-muted">
                View: they open it and work in it. Can edit: they change its draft from their own conversations too. You
                publish it.
              </p>
            </Modal.Header>
            <Modal.Body className="flex flex-col gap-4">
              <div className="flex items-center gap-2">
                <SearchField value={find} onChange={setFind} aria-label="Find someone" className="flex-1">
                  <SearchField.Group>
                    <SearchField.SearchIcon />
                    <SearchField.Input placeholder="Find someone by name or email" />
                    <SearchField.ClearButton />
                  </SearchField.Group>
                </SearchField>
                <RoleSelect label="Add them to" value={role} onChange={setRole} viewOnly={false} />
              </div>
              {q ? (
                <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
                  {matches.length ? (
                    matches.map((m) => {
                      return (
                        <li key={m.userId} className="flex items-center gap-3 px-3 py-1.5">
                          <span className="flex min-w-0 flex-1 flex-col">
                            <span className="truncate text-body">{m.name}</span>
                            <span className="truncate text-small text-muted-tertiary">
                              {m.email}
                              {m.viewer && role === "edit" ? " · a viewer here: added to view" : ""}
                            </span>
                          </span>
                          <Button
                            size="sm"
                            variant="secondary"
                            isPending={pending === m.userId}
                            onPress={() =>
                              void set(m.userId, m.as, `Shared with ${m.name}.`).then((ok) => ok && setFind(""))
                            }
                          >
                            <UserPlus className="size-3.5" aria-hidden />
                            Add
                          </Button>
                        </li>
                      );
                    })
                  ) : (
                    <li className="px-3 py-2 text-small text-muted">
                      {members.length ? "Nobody else here matches." : "There's nobody else in this workspace yet."}
                    </li>
                  )}
                </ul>
              ) : null}
              {shares.isPending ? (
                <p className="text-small text-muted">Reading who it's shared with…</p>
              ) : people.length ? (
                <ul className="flex flex-col divide-y divide-border">
                  {people.map((p) => (
                    <li key={p.userId} className="flex items-center gap-3 py-2">
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-body">{p.name}</span>
                        {p.email ? <span className="truncate text-small text-muted-tertiary">{p.email}</span> : null}
                      </span>
                      <RoleSelect
                        label={`What ${p.name} may do`}
                        value={p.role}
                        viewOnly={viewers.has(p.userId)}
                        onChange={(next) => next !== p.role && void set(p.userId, next)}
                      />
                      <Button
                        isIconOnly
                        size="sm"
                        variant="ghost"
                        aria-label={`Stop sharing with ${p.name}`}
                        isPending={pending === p.userId}
                        onPress={() => void set(p.userId, null)}
                      >
                        <X className="size-3.5" aria-hidden />
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-small text-muted">It isn't shared with anyone by name yet.</p>
              )}
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

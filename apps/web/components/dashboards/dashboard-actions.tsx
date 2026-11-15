"use client";

import { AlertDialog, Button, buttonVariants, Dropdown, Label, Separator, toast } from "@heroui/react";
import type { DashboardPage } from "@opendash/api/client";
import { isDefinedError } from "@opendash/api/client";
import { useQuery } from "@tanstack/react-query";
import { History, MessageSquareText, Trash2, Users } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, apiQueries } from "@/lib/api";
import { ago } from "@/lib/format";
import { SelectToggle } from "./select-toggle";
import { peopleWords, SharePeopleDialog, seenByWords } from "./share-people";

const VISIBILITY = { private: "Only you", project: "Its project", org: "Everyone" } as const;
/** The menu's way to the people dialog: not a visibility. */
const PEOPLE = "people";
const message = (e: unknown, fallback: string) => (isDefinedError(e) ? (e as { message: string }).message : fallback);

/**
 * A dashboard's actions in its top bar: its versions (Restore one, its owner's), who it's shared with (its owner's
 * call: its visibility, and specific people to view or edit it), and Delete (its owner, or an owner or admin).
 * Someone it's shared with by name is told how.
 */
export function DashboardActions({
  dashboard,
  canManage,
  selectable = false,
}: {
  dashboard: DashboardPage;
  canManage: boolean;
  /** Select to edit: its owner, with the App drawn on the page. */
  selectable?: boolean;
}) {
  const router = useRouter();
  const [now] = useState(() => Date.now());
  const [deleting, setDeleting] = useState(false);
  const [sharing, setSharing] = useState(false);
  const seenBy = seenByWords(dashboard.visibility, dashboard.people);
  const versions = useQuery(apiQueries.dashboards.versions.queryOptions({ input: { dashboardId: dashboard.id } }));
  const act = async (fn: () => Promise<unknown>, done: string, fallback: string) => {
    try {
      await fn();
      toast.success(done);
      router.refresh();
    } catch (e) {
      toast.danger(message(e, fallback));
    }
  };
  return (
    <div className="flex items-center gap-1">
      {selectable ? <SelectToggle dashboardId={dashboard.id} /> : null}
      {/* The conversation it was built in, where a change to it is asked. */}
      {dashboard.mine && dashboard.threadId ? (
        <Link href={`/ask/${dashboard.threadId}`} className={buttonVariants({ size: "sm", variant: "ghost" })}>
          <MessageSquareText className="size-3.5" aria-hidden />
          Continue
        </Link>
      ) : null}
      {dashboard.mine ? (
        <Dropdown>
          <Button size="sm" variant="ghost" aria-label="Who sees it">
            <Users className="size-3.5" aria-hidden />
            {seenBy}
          </Button>
          <Dropdown.Popover placement="bottom end">
            <Dropdown.Menu
              aria-label="Who sees it"
              onAction={(key) =>
                String(key) === PEOPLE
                  ? setSharing(true)
                  : void act(
                      () =>
                        api.dashboards.share({
                          dashboardId: dashboard.id,
                          visibility: String(key) as keyof typeof VISIBILITY,
                        }),
                      "Sharing changed.",
                      "Couldn't change who sees it.",
                    )
              }
            >
              <Dropdown.Section>
                {(Object.keys(VISIBILITY) as (keyof typeof VISIBILITY)[])
                  .filter((v) => v !== "project" || dashboard.projectId)
                  .map((v) => (
                    <Dropdown.Item key={v} id={v} textValue={VISIBILITY[v]}>
                      <Label>{VISIBILITY[v]}</Label>
                    </Dropdown.Item>
                  ))}
              </Dropdown.Section>
              <Separator />
              <Dropdown.Section>
                <Dropdown.Item id={PEOPLE} textValue="Specific people">
                  <span className="flex min-w-0 flex-col">
                    <Label>Specific people…</Label>
                    <span className="truncate text-small text-muted-tertiary">
                      {dashboard.people ? `Shared with ${peopleWords(dashboard.people)}` : "Each to view or to edit"}
                    </span>
                  </span>
                </Dropdown.Item>
              </Dropdown.Section>
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
      ) : dashboard.sharedRole ? (
        <span className="flex items-center gap-1.5 px-2 text-small text-muted">
          <Users className="size-3.5" aria-hidden />
          {dashboard.sharedRole === "edit" ? "Shared with you to edit" : "Shared with you"}
        </span>
      ) : null}
      {dashboard.mine ? <SharePeopleDialog dashboard={dashboard} isOpen={sharing} onOpenChange={setSharing} /> : null}

      {/* Versions once there's one: a dashboard still being built has only its draft. */}
      {dashboard.currentVersion ? (
        <Dropdown>
          <Button size="sm" variant="ghost" aria-label="Versions">
            <History className="size-3.5" aria-hidden />v{dashboard.currentVersion}
          </Button>
          <Dropdown.Popover placement="bottom end" className="min-w-72">
            <Dropdown.Menu
              aria-label="Versions"
              disabledKeys={
                dashboard.mine
                  ? [String(dashboard.currentVersion)]
                  : (versions.data ?? []).map((v) => String(v.version))
              }
              onAction={(key) =>
                void act(
                  async () => {
                    await api.dashboards.restore({
                      dashboardId: dashboard.id,
                      version: Number(key),
                      expectedVersion: dashboard.currentVersion,
                    });
                    await versions.refetch();
                  },
                  `Version ${String(key)} is the current one again.`,
                  "Couldn't restore it.",
                )
              }
            >
              {(versions.data ?? []).map((v) => (
                <Dropdown.Item key={v.version} id={String(v.version)} textValue={`Version ${v.version}`}>
                  <span className="flex min-w-0 flex-col">
                    <Label>
                      v{v.version}
                      {v.version === dashboard.currentVersion ? " · current" : dashboard.mine ? " · restore" : ""}
                    </Label>
                    <span className="truncate text-small text-muted-tertiary">
                      {[v.changeNote, v.by, ago(v.createdAt, now)].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                </Dropdown.Item>
              ))}
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
      ) : null}
      {dashboard.mine || canManage ? (
        <Button size="sm" variant="ghost" isIconOnly aria-label="Delete it" onPress={() => setDeleting(true)}>
          <Trash2 className="size-3.5 text-muted" aria-hidden />
        </Button>
      ) : null}
      <AlertDialog>
        <AlertDialog.Backdrop isOpen={deleting} onOpenChange={setDeleting}>
          <AlertDialog.Container>
            <AlertDialog.Dialog>
              <AlertDialog.Header>
                <AlertDialog.Heading>Delete “{dashboard.title}”?</AlertDialog.Heading>
              </AlertDialog.Header>
              <AlertDialog.Body>
                <p className="text-body text-muted">
                  It's gone for everyone it's shared with, its versions too. Its data isn't touched.
                </p>
              </AlertDialog.Body>
              <AlertDialog.Footer>
                <Button variant="ghost" slot="close">
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  onPress={() =>
                    void act(
                      async () => {
                        await api.dashboards.delete({ dashboardId: dashboard.id });
                        setDeleting(false);
                        router.push("/dashboards");
                      },
                      "Deleted.",
                      "Couldn't delete it.",
                    )
                  }
                >
                  Delete dashboard
                </Button>
              </AlertDialog.Footer>
            </AlertDialog.Dialog>
          </AlertDialog.Container>
        </AlertDialog.Backdrop>
      </AlertDialog>
    </div>
  );
}

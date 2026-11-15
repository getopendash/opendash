import { askableSources, getProject, listFolders, projectKeyTables, projectPeople } from "@opendash/core";
import { isUuid, withTenant } from "@opendash/db";
import { MessageSquare } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { FolderMenu, type FolderScope, FolderStrip } from "@/components/projects/folders";
import { KeyTables } from "@/components/projects/key-tables";
import { type OrgMember, type Person, ProjectActions } from "@/components/projects/project-actions";
import { ProjectAvatar } from "@/components/projects/project-avatar";
import { TopBar } from "@/components/shell/top-bar";
import { requireTenant } from "@/lib/auth";
import { ago } from "@/lib/format";
import { projectThreadsFor } from "@/lib/project-data";
import { actorOf } from "@/lib/projects";
import { teamOf } from "@/lib/team";
import { currentWorkspace } from "@/lib/workspace";

export const metadata: Metadata = { title: "Project · OpenDash" };

const ROLE = { manager: "Manager", editor: "Editor", viewer: "Viewer" } as const;
const SHARED = { private: "Only its owner", project: "Project", org: "Everyone" } as const;

/** A project: what's in it that this person can read, by folder, and its people. */
export default async function ProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ folder?: string }>;
}) {
  const [{ id }, { folder: rawFolder }] = await Promise.all([params, searchParams]);
  if (!isUuid(id)) notFound();
  const viewer = await requireTenant();
  const actor = actorOf(viewer);
  const data = await withTenant(viewer.ctx, async (tx) => {
    const project = await getProject(tx, actor, id);
    if (!project) return null;
    return {
      project,
      people: await projectPeople(tx, actor, id),
      folders: await listFolders(tx, actor, id),
      keyTables: await projectKeyTables(tx, actor, id),
      sources: await askableSources(tx, viewer.ctx.orgId),
    };
  });
  if (!data) notFound();
  const { project, people, folders, keyTables, sources } = data;
  const [allThreads, team, ws] = await Promise.all([
    projectThreadsFor(viewer.ctx.orgId, viewer.user.id, id),
    teamOf(viewer.ctx.orgId),
    currentWorkspace(),
  ]);
  const byId = new Map(team.members.map((m) => [m.userId, m]));
  const named: Person[] = people.map((p) => ({
    userId: p.userId,
    role: p.role,
    name: byId.get(p.userId)?.name || byId.get(p.userId)?.email || "Someone who left",
    email: byId.get(p.userId)?.email ?? "",
  }));
  const members: OrgMember[] = team.members.map((m) => ({
    userId: m.userId,
    name: m.name,
    email: m.email,
    orgRole: m.role,
  }));
  const manages = project.role === "manager" || viewer.role === "owner" || viewer.role === "admin";
  const canAdd = (project.role === "manager" || project.role === "editor") && viewer.role !== "viewer";
  // ?folder= one folder's id, or "none": what's in no folder. Anything else shows all of it.
  const scope: FolderScope =
    rawFolder === "none" || folders.some((f) => f.id === rawFolder) ? (rawFolder as string) : "all";
  const inScope = (folderId: string | null) =>
    scope === "all" ? true : scope === "none" ? folderId === null : folderId === scope;
  const threads = allThreads.filter((t) => inScope(t.folderId));
  const counts = {
    all: allThreads.length,
    none: allThreads.filter((t) => !t.folderId).length,
  };
  const nameOf = (userId: string | null) =>
    userId === viewer.user.id ? "You" : userId ? (byId.get(userId)?.name ?? "A teammate") : "An API key";
  const now = Date.now();
  return (
    <>
      <TopBar
        crumbs={[{ label: "Projects", href: "/projects" }, { label: project.name }]}
        action={
          <ProjectActions
            project={project}
            org={ws.org.name}
            people={named}
            members={members}
            me={viewer.user.id}
            canAdd={canAdd}
            manages={manages}
          />
        }
      />
      <div className="flex-1 overflow-y-auto px-6 pt-6 pb-16 @2xl/page:px-8">
        <div className="flex flex-col gap-8">
          <div className="flex items-center gap-3">
            <ProjectAvatar id={project.id} name={project.name} size="lg" />
            <div className="flex min-w-0 flex-col gap-0.5">
              <h1 className="truncate text-display">{project.name}</h1>
              <p className="text-small text-muted-tertiary">
                {[
                  project.description,
                  `${project.people} ${project.people === 1 ? "person" : "people"}`,
                  project.visibility === "org" ? `open to everyone at ${ws.org.name}` : "only its people can open it",
                  project.role ? `your role: ${ROLE[project.role].toLowerCase()}` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </div>
          </div>
          <div className="flex flex-col gap-10 @5xl/page:flex-row">
            <div className="flex min-w-0 flex-1 flex-col gap-8">
              <FolderStrip projectId={id} folders={folders} scope={scope} counts={counts} canEdit={canAdd} />
              <section aria-labelledby="conversations-title" className="flex flex-col gap-1">
                <div className="flex items-baseline justify-between pb-1">
                  <h2 id="conversations-title" className="text-body font-medium">
                    Conversations
                  </h2>
                  <span className="text-small text-muted-tertiary">{threads.length}</span>
                </div>
                {threads.length ? (
                  <ul className="flex flex-col divide-y divide-border border-t border-border">
                    {threads.map((t) => (
                      <li key={t.id} className="flex items-center gap-1">
                        <Link
                          href={`/ask/${t.id}`}
                          className="flex min-w-0 flex-1 items-center gap-3 py-2.5 hover:bg-default"
                        >
                          <MessageSquare className="size-3.5 shrink-0 text-muted-tertiary" aria-hidden />
                          <span className="min-w-0 flex-1 truncate text-body">{t.title}</span>
                          <span className="hidden w-28 text-small text-muted-tertiary @2xl/page:block">
                            {SHARED[t.visibility]}
                          </span>
                          <span className="hidden w-28 truncate text-small text-muted @2xl/page:block">
                            {nameOf(t.createdBy)}
                          </span>
                          <span className="w-20 text-right text-small text-muted-tertiary">
                            {ago(t.lastMessageAt ?? t.createdAt, now)}
                          </span>
                        </Link>
                        {folders.length && canAdd && t.createdBy === viewer.user.id ? (
                          <FolderMenu
                            projectId={id}
                            item={{ kind: "thread", id: t.id }}
                            title={t.title}
                            folders={folders}
                            current={t.folderId}
                          />
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="border-t border-border py-4 text-body text-muted">
                    {canAdd
                      ? "No conversations yet. Ask a question here, or move one in from its menu."
                      : "Nothing is shared with this project yet."}
                  </p>
                )}
              </section>
            </div>
            <aside
              aria-labelledby="people-title"
              className="flex w-full flex-col gap-1 @5xl/page:w-72 @5xl/page:shrink-0"
            >
              <h2 id="people-title" className="pb-1 text-body font-medium">
                People
              </h2>
              <ul className="flex flex-col divide-y divide-border border-t border-border">
                {named.map((p) => (
                  <li key={p.userId} className="flex items-center gap-2.5 py-2.5">
                    <span className="min-w-0 flex-1 truncate text-body">
                      {p.userId === viewer.user.id ? `${p.name} (you)` : p.name}
                    </span>
                    <span className="text-small text-muted-tertiary">{ROLE[p.role]}</span>
                  </li>
                ))}
              </ul>
              <KeyTables
                projectId={id}
                projectName={project.name}
                tables={keyTables}
                sources={sources.map((src) => ({ id: src.id, name: src.name }))}
                manages={manages}
              />
            </aside>
          </div>
        </div>
      </div>
    </>
  );
}

import { listProjects } from "@opendash/core";
import { withTenant } from "@opendash/db";
import type { Metadata } from "next";
import Link from "next/link";
import { NewProject } from "@/components/projects/new-project";
import { ProjectAvatar } from "@/components/projects/project-avatar";
import { TopBar } from "@/components/shell/top-bar";
import { requireTenant } from "@/lib/auth";
import { actorOf } from "@/lib/projects";
import { currentWorkspace } from "@/lib/workspace";

export const metadata: Metadata = { title: "Projects · OpenDash" };

const ROLE = { manager: "Manager", editor: "Editor", viewer: "Viewer" } as const;

/** The projects this person can open: theirs, those open to the organization, and (owners and admins) all. */
export default async function ProjectsPage() {
  const viewer = await requireTenant();
  const [projects, ws] = await Promise.all([
    withTenant(viewer.ctx, (tx) => listProjects(tx, actorOf(viewer))),
    currentWorkspace(),
  ]);
  return (
    <>
      <TopBar
        crumbs={[{ label: "Projects" }]}
        action={viewer.role !== "viewer" ? <NewProject org={ws.org.name} /> : null}
      />
      <div className="flex-1 overflow-y-auto px-6 pt-6 pb-16 @2xl/page:px-8">
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-1.5">
            <h1 className="text-display">Projects</h1>
            <p className="text-body text-muted">
              Places for a piece of work: its conversations and dashboards, shared with the people on it.
            </p>
          </div>
          {projects.length ? (
            <div className="overflow-x-auto rounded-2xl border border-border">
              <table className="w-full text-body">
                <thead>
                  <tr className="border-b border-border text-left text-small text-muted-tertiary">
                    <th className="px-4 py-2.5 font-normal">Name</th>
                    <th className="hidden px-4 py-2.5 font-normal @2xl/page:table-cell">People</th>
                    <th className="hidden px-4 py-2.5 font-normal @2xl/page:table-cell">Conversations</th>
                    <th className="hidden px-4 py-2.5 font-normal @2xl/page:table-cell">Dashboards</th>
                    <th className="px-4 py-2.5 font-normal">Your role</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {projects.map((p) => (
                    <tr key={p.id} className="hover:bg-default">
                      <td className="px-4 py-2.5">
                        <Link href={`/projects/${p.id}`} className="flex items-center gap-3">
                          <ProjectAvatar id={p.id} name={p.name} size="md" />
                          <span className="flex min-w-0 flex-col">
                            <span className="truncate font-medium">{p.name}</span>
                            <span className="truncate text-small text-muted-tertiary">
                              {p.description ??
                                (p.visibility === "org" ? `Open to everyone at ${ws.org.name}` : "People only")}
                            </span>
                          </span>
                        </Link>
                      </td>
                      <td className="hidden px-4 py-2.5 tabular-nums text-muted @2xl/page:table-cell">{p.people}</td>
                      <td className="hidden px-4 py-2.5 tabular-nums text-muted @2xl/page:table-cell">
                        {p.conversations}
                      </td>
                      <td className="hidden px-4 py-2.5 tabular-nums text-muted @2xl/page:table-cell">
                        {p.dashboards}
                      </td>
                      <td className={`px-4 py-2.5 ${p.role ? "text-muted" : "text-muted-tertiary"}`}>
                        {p.role ? ROLE[p.role] : "Not in it"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2 rounded-2xl border border-border px-6 py-12 text-center">
              <p className="text-body font-medium">No projects yet</p>
              <p className="max-w-form text-body text-muted">
                A project keeps a piece of work together: the conversations and dashboards for the board pack, or Q4
                pricing, shared with the people working on it.
              </p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

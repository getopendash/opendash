import { buttonVariants } from "@heroui/react";
import { askableSources, getContextItem, getProject } from "@opendash/core";
import { isUuid, withTenant } from "@opendash/db";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { NewQuestion } from "@/components/ask/new-question";
import { TopBar } from "@/components/shell/top-bar";
import { requireTenant } from "@/lib/auth";
import { canVerify } from "@/lib/knowledge";
import { actorOf } from "@/lib/projects";
import { canAsk } from "@/lib/team";

export const metadata: Metadata = { title: "New question · OpenDash" };

/**
 * A new question, about one of the sources that were learned (?source= picks one; ?q= starts the text). A skill's Try
 * now: ?attach=skill:<id>@<version> starts it with that skill attached (a draft only for owners and admins).
 */
export default async function NewQuestionPage({
  searchParams,
}: {
  searchParams: Promise<{ source?: string; q?: string; attach?: string; project?: string }>;
}) {
  const [{ source, q, attach, project: projectId }, viewer] = await Promise.all([searchParams, requireTenant()]);
  // Viewers read what's shared with them; the API refuses their questions too.
  if (!canAsk(viewer.role)) redirect("/ask");
  const skillAttach = /^skill:([0-9a-f-]{36})(?:@(\d+))?$/i.exec(attach ?? "");
  const [sources, project] = await withTenant(viewer.ctx, async (tx) => [
    await askableSources(tx, viewer.ctx.orgId),
    // ?project= starts it in a project this person can add to (a project's New question).
    projectId && isUuid(projectId) ? await getProject(tx, actorOf(viewer), projectId) : null,
  ]);
  const skill =
    skillAttach?.[1] && isUuid(skillAttach[1])
      ? await withTenant(viewer.ctx, (tx) => getContextItem(tx, viewer.ctx.orgId, skillAttach[1] as string))
      : null;
  const version = skillAttach?.[2] ? Number(skillAttach[2]) : (skill?.releasedVersion ?? null);
  // A draft is tried by owners and admins; the server checks again when the question is asked.
  const tried =
    skill?.kind === "skill" && version && (version === skill.releasedVersion || canVerify(viewer.role))
      ? {
          kind: "skill" as const,
          id: skill.id,
          version,
          title: version === skill.releasedVersion ? skill.title : `${skill.title} · draft v${version}`,
        }
      : null;
  const inProject = project && (project.role === "manager" || project.role === "editor") ? project : null;
  const chosen = source;
  return (
    <>
      <TopBar
        crumbs={
          inProject
            ? [{ label: inProject.name, href: `/projects/${inProject.id}` }, { label: "New question" }]
            : [{ label: "Ask", href: "/ask" }, { label: "New question" }]
        }
      />
      <div className="flex-1 overflow-y-auto px-6 pb-16">
        {sources.length ? (
          <NewQuestion
            sources={sources}
            initialSource={sources.some((s) => s.id === chosen) ? (chosen ?? null) : null}
            {...(q ? { initialText: q.slice(0, 500) } : {})}
            {...(inProject ? { project: { id: inProject.id, name: inProject.name } } : {})}
            {...(tried ? { attached: [tried] } : {})}
          />
        ) : (
          <div className="mx-auto flex max-w-form flex-col items-center gap-3 pt-24 text-center">
            <h1 className="text-title">Nothing to ask about yet</h1>
            <p className="text-body text-muted">
              Connect a database and let OpenDash learn it first. It takes a few minutes.
            </p>
            <Link href="/data/sources" className={buttonVariants({ size: "md" })}>
              Go to Sources
            </Link>
          </div>
        )}
      </div>
    </>
  );
}

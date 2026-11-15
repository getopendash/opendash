import { isUuid } from "@opendash/db";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ThreadView } from "@/components/ask/thread-view";
import { threadFor } from "@/lib/ask";
import { requireTenant } from "@/lib/auth";
import { canVerify } from "@/lib/knowledge";
import { projectChoices } from "@/lib/project-data";
import { canAsk } from "@/lib/team";
import { currentWorkspace } from "@/lib/workspace";

export async function generateMetadata({ params }: { params: Promise<{ threadId: string }> }): Promise<Metadata> {
  const viewer = await requireTenant();
  const thread = await threadFor(viewer.ctx.orgId, viewer.user.id, (await params).threadId);
  return { title: `${thread?.thread.title ?? "Conversation"} · OpenDash` };
}

/** A conversation. Visible to its author, its project's people or the org once shared; anyone else gets a 404. */
export default async function ThreadPage({ params }: { params: Promise<{ threadId: string }> }) {
  const { threadId } = await params;
  if (!isUuid(threadId)) notFound();
  const [viewer, ws] = await Promise.all([requireTenant(), currentWorkspace()]);
  if (!(await threadFor(viewer.ctx.orgId, viewer.user.id, threadId))) notFound();
  const projects = await projectChoices(viewer);
  return (
    <ThreadView
      threadId={threadId}
      org={ws.org.name}
      canAsk={canAsk(viewer.role)}
      canVerify={canVerify(viewer.role)}
      projects={projects}
    />
  );
}

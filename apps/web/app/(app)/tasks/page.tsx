import type { Metadata } from "next";
import { TasksView } from "@/components/tasks/tasks-view";
import { requireTenant } from "@/lib/auth";
import { canVerify } from "@/lib/knowledge";
import { canAsk } from "@/lib/roles";
import { tasksFor } from "@/lib/tasks";

export const metadata: Metadata = { title: "Tasks · OpenDash" };

/** Q4: the organization's tasks (?status=closed for done and dismissed). */
export default async function TasksPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const [{ status }, viewer] = await Promise.all([searchParams, requireTenant()]);
  const closed = status === "closed";
  const who = { orgId: viewer.ctx.orgId, userId: viewer.user.id };
  const [tasks, open] = await Promise.all([
    tasksFor(who, { status: closed ? "closed" : "open" }),
    closed ? tasksFor(who, { status: "open", limit: 200 }) : null,
  ]);
  return (
    <TasksView
      tasks={tasks}
      closed={closed}
      openCount={(open ?? tasks).length}
      canManage={canVerify(viewer.role)}
      canAsk={canAsk(viewer.role)}
    />
  );
}

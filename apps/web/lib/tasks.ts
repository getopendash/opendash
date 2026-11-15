import "server-only";
import { listTasks } from "@opendash/core";
import { withTenant } from "@opendash/db";

/** Tasks: open or closed, the viewer's own or everyone's. */
export const tasksFor = (
  viewer: { orgId: string; userId: string },
  options: { status?: "open" | "closed"; mine?: boolean; limit?: number } = {},
) => withTenant({ orgId: viewer.orgId }, (tx) => listTasks(tx, viewer, options));

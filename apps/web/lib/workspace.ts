import "server-only";
import { getAuthDatabase, memberCount, memberships } from "@opendash/auth";
import { definitionCounts, hasAsked, listSourceStates, type SourceStatus } from "@opendash/core";
import { withTenant } from "@opendash/db";
import { cache } from "react";
import { requireTenant } from "./auth";

export interface WorkspaceSummary {
  user: { id: string; name: string; email: string };
  role: string;
  org: { id: string; name: string; slug: string };
  /** Every organization this person belongs to, for the switcher. */
  orgs: { id: string; name: string; slug: string }[];
  members: number;
  sources: number;
  /** Each live source's status, for the setup card and the sidebar's status pill. */
  sourceStates: { id: string; name: string; status: SourceStatus; learnedAt: string | null }[];
  /** Whether this person has asked a question here yet. */
  asked: boolean;
  /** Definitions waiting for review (the starter pack) and verified ones. */
  definitions: { proposed: number; verified: number };
}

/** The signed-in workspace, loaded once per request and shared by the shell and the page. */
export const currentWorkspace = cache(async (): Promise<WorkspaceSummary> => {
  const viewer = await requireTenant();
  const database = getAuthDatabase();
  const [list, members, [states, asked, definitions]] = await Promise.all([
    memberships(database, viewer.user.id),
    memberCount(database, viewer.ctx.orgId),
    withTenant(viewer.ctx, async (tx) => {
      const viewing = { orgId: viewer.ctx.orgId, userId: viewer.user.id };
      return [
        await listSourceStates(tx, viewer.ctx.orgId),
        await hasAsked(tx, viewing),
        await definitionCounts(tx, viewer.ctx.orgId),
      ] as const;
    }),
  ]);
  const org = list.find((o) => o.id === viewer.ctx.orgId) ?? { id: viewer.ctx.orgId, name: "Workspace", slug: "" };
  return {
    user: viewer.user,
    role: viewer.role,
    org,
    orgs: list,
    members: members || 1,
    sources: states.length,
    sourceStates: states.map((s) => ({ id: s.id, name: s.name, status: s.status, learnedAt: s.learnedAt })),
    asked,
    definitions,
  };
});

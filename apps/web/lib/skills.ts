import "server-only";
import { answersFollowing, getContextItem, listContext, SKILL_MAX, skillFollowCounts } from "@opendash/core";
import { withTenant } from "@opendash/db";

const DAY = 86_400_000;

/** The skills, each with how many answers followed it in the last 30 days. */
export async function skillsFor(orgId: string) {
  return withTenant({ orgId }, async (tx) => {
    const items = await listContext(tx, orgId, "skill");
    const counts = await skillFollowCounts(
      tx,
      orgId,
      items.map((i) => i.id),
      new Date(Date.now() - 30 * DAY),
    );
    return items.map((i) => ({ ...i, followed: counts.get(i.id) ?? 0 }));
  });
}

/** A skill, and the latest answers that followed it among those this person can read. */
export async function skillFor(orgId: string, userId: string, id: string) {
  return withTenant({ orgId, userId }, async (tx) => {
    const item = await getContextItem(tx, orgId, id);
    if (item?.kind !== "skill") return null;
    const [answers, counts] = await Promise.all([
      answersFollowing(tx, { orgId, userId }, id),
      skillFollowCounts(tx, orgId, [id], new Date(Date.now() - 30 * DAY)),
    ]);
    return { item, answers, followed: counts.get(id) ?? 0 };
  });
}

export const SKILL_LIMIT = SKILL_MAX;

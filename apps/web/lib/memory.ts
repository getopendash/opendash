import "server-only";
import { listMemories } from "@opendash/core";
import { sql, withTenant } from "@opendash/db";

/** This person's memories, with the conversation each was saved in when they can still open it. */
export async function memoriesFor(orgId: string, userId: string) {
  return withTenant({ orgId, userId }, async (tx) => {
    const memories = await listMemories(tx, orgId, userId);
    const ids = [...new Set(memories.flatMap((m) => (m.threadId ? [m.threadId] : [])))];
    const threads = ids.length
      ? await tx.execute<{ id: string; title: string | null }>(sql`
          select id, title from app.thread
          where org_id = ${orgId} and id in (${sql.join(
            ids.map((id) => sql`${id}::uuid`),
            sql`, `,
          )}) and (created_by = ${userId} or visibility = 'org')`)
      : [];
    const titles = new Map(threads.map((t) => [t.id, t.title]));
    return memories.map((m) => ({
      ...m,
      thread:
        m.threadId && titles.has(m.threadId)
          ? { id: m.threadId, title: titles.get(m.threadId) ?? "A conversation" }
          : null,
    }));
  });
}

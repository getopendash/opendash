/**
 * Someone left the workspace: their own connections go, with the tokens or keys behind them (the secrets
 * go with their rows, migration 0086, and sign-ins end at the services that take revocations), and so do sign-ins
 * they started and never finished. Shared connections stay:
 * they're the workspace's, whoever connected them. Row security shows a person's own connections only as that
 * person, so this runs as them; it changes nothing else.
 */
import { sql } from "@opendash/db";
import { revokeAtServer } from "./revoke";
import { type McpDeps, readCredentials, type StoredCredentials } from "./shared";

export async function personLeft(
  deps: McpDeps,
  orgId: string,
  userId: string,
): Promise<{ connections: number; signIns: number }> {
  const done = await deps.withTenant({ orgId, userId }, async (tx) => {
    const connections = await tx.execute<{ secret_id: string; discovery: Record<string, unknown> | null }>(sql`
      select secret_id, discovery from app.mcp_connection
      where org_id = ${orgId} and scope = 'personal' and scope_id = ${userId}`);
    const held: { credentials: StoredCredentials | null; discovery: Record<string, unknown> | null }[] = [];
    for (const c of connections) {
      held.push({
        credentials: await readCredentials(deps, tx, orgId, c.secret_id).catch(() => null),
        discovery: c.discovery,
      });
    }
    await tx.execute(sql`
      delete from app.mcp_connection where org_id = ${orgId} and scope = 'personal' and scope_id = ${userId}`);
    const signIns = await tx.execute(sql`
      delete from app.mcp_oauth_flow where org_id = ${orgId} and started_by = ${userId} returning id`);
    return { held, signIns: signIns.length };
  });
  // Their sign-ins end at the services too, where the services take revocations (best effort).
  await Promise.all(done.held.map((h) => revokeAtServer(deps, h.credentials, h.discovery)));
  return { connections: done.held.length, signIns: done.signIns };
}

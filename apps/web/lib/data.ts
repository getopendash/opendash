import "server-only";
import { disconnectSlack, type ExportPart, exportArchive, mcp, memberLeft, personErased } from "@opendash/core";
import { withTenant } from "@opendash/db";
import { mcpDeps } from "./mcp";
import { slackDeps, slackRevoke } from "./slack";

/**
 * A person's and a workspace's own data: taking it out (an export, downloaded as it's made) and what the product
 * does around a deletion. The deletions themselves are the auth package's (`deleteOrganization`, `deleteAccount`).
 */

/** How long giving a Slack token back may take before a deletion goes on without it. */
const SLACK_REVOKE_MS = 5_000;

/**
 * A workspace about to be deleted gives Slack its token back first (afterwards there's no token to give). Best
 * effort: a deletion never waits on Slack for long, or fails because of it; the token is deleted either way.
 */
export async function releaseSlack(orgId: string): Promise<void> {
  try {
    const gone = await withTenant({ orgId }, (tx) => disconnectSlack(slackDeps, tx, orgId));
    if (gone.token) {
      await Promise.race([slackRevoke(gone.token), new Promise((resolve) => setTimeout(resolve, SLACK_REVOKE_MS))]);
    }
  } catch {
    // Not connected, or its token can't be read: nothing to give back.
  }
}

/**
 * Someone whose account is deleted, in a workspace that stays: what leaving it ends (their routines and shares,
 * their own connections to MCP servers), and what was theirs alone (their private conversations and dashboards,
 * their settings).
 */
export async function erasedFromWorkspace(orgId: string, userId: string): Promise<void> {
  await withTenant({ orgId, userId }, async (tx) => {
    await memberLeft(tx, orgId, userId);
    await personErased(tx, orgId, userId);
  });
  const deps = mcpDeps();
  if (deps) await mcp.personLeft(deps, orgId, userId);
}

/** An export as a download: the zip's bytes go out as they're made, a page of rows at a time. */
export function exportDownload(
  filename: string,
  parts: ExportPart[],
  extra: { name: string; json: unknown }[],
): Response {
  const bytes = exportArchive({ withTenant }, parts, extra);
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await bytes.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await bytes.return(undefined);
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

/** Today, for a file's name. */
export const exportDate = (now: Date = new Date()) => now.toISOString().slice(0, 10);

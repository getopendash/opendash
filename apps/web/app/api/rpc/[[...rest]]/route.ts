import { createRpcHandler } from "@opendash/api";
import { getAuthDatabase, memberNames, orgPeople, TenantAccessDenied } from "@opendash/auth";
import { deploymentKeys } from "@opendash/core";
import { withTenant } from "@opendash/db";
import { currentTenant } from "@/lib/auth";
import { frameUrl } from "@/lib/frames";
import { mcpDeps } from "@/lib/mcp";
import { queue, secretStore } from "@/lib/sources";

/**
 * The typed API over RPC, for the web UI's client (@opendash/api/client). The caller is resolved from the
 * request's session (or an API key) with the membership check; every handler then works inside withTenant.
 */
const handle = createRpcHandler(
  {
    withTenant: (orgId, fn) => withTenant({ orgId }, fn),
    withUser: (orgId, userId, fn) => withTenant({ orgId, userId }, fn),
    resolveTenant: async () => {
      const principal = await currentTenant();
      if (!principal) return null;
      return {
        orgId: principal.ctx.orgId,
        userId: principal.ctx.userId ?? null,
        channel: principal.kind === "session" ? "web" : "api",
        ...("role" in principal ? { role: principal.role } : {}),
        ...("keyId" in principal ? { keyId: principal.keyId } : {}),
      };
    },
    authors: (orgId, userIds) => memberNames(getAuthDatabase(), orgId, userIds),
    people: (orgId) => orgPeople(getAuthDatabase(), orgId),
    boss: queue,
    // Names only: which providers this deployment has a key for. The keys stay in the environment.
    deploymentKeys: deploymentKeys(),
    secrets: secretStore(),
    frameUrl,
    mcp: mcpDeps(),
  },
  { prefix: "/api/rpc" },
);

async function handleRequest(request: Request) {
  try {
    return await handle(request);
  } catch (error) {
    if (error instanceof TenantAccessDenied) return Response.json({ error: "forbidden" }, { status: 403 });
    throw error;
  }
}

export const GET = handleRequest;
export const POST = handleRequest;

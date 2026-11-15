import "server-only";
import { mcp } from "@opendash/core";
import { withTenant } from "@opendash/db";
import { webOrigin } from "./slack";
import { secretStore } from "./sources";

/**
 * MCP connections, the web's part: what core needs to reach servers and keep people's accounts. Sign-ins
 * come back to /api/mcp/callback; OpenDash's client metadata document is at /api/mcp/client, offered to
 * authorization servers that take one only when this server is on https (they fetch it).
 */
export function mcpDeps(): mcp.McpDeps | undefined {
  const origin = webOrigin();
  if (!origin) return undefined;
  return {
    secrets: secretStore(),
    edition: process.env.OPENDASH_EDITION === "cloud" ? "cloud" : "community",
    withTenant: (ctx, fn) => withTenant(ctx, fn),
    redirectUrl: `${origin}/api/mcp/callback`,
    ...(origin.startsWith("https://") ? { clientMetadataUrl: `${origin}/api/mcp/client` } : {}),
    clientName: "OpenDash",
  };
}

/** Whether connections are on here: they are, unless OPENDASH_MCP=0. */
export const mcpOn = (): boolean => mcp.mcpEnabled();

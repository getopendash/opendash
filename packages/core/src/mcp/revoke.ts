/**
 * Ending a sign-in at the service too (RFC 7009), when an account is disconnected or its person leaves: if the
 * authorization server says where it takes revocations, OpenDash sends the refresh token (which ends the access token
 * with it at most servers) and the access token, through the guard, with the client's own credentials. Best effort:
 * the connection is already gone in OpenDash whatever the service answers.
 */
import type { OAuthDiscoveryState } from "@modelcontextprotocol/client";
import { BUDGETS } from "../budgets";
import { isKey, type McpDeps, oauthFetchFor, type StoredCredentials } from "./shared";

export async function revokeAtServer(
  deps: McpDeps,
  credentials: StoredCredentials | null,
  discovery: Record<string, unknown> | null,
): Promise<boolean> {
  if (!credentials || isKey(credentials)) return false;
  // An OAuth server's metadata (RFC 8414) names it; OpenID Connect's type doesn't list it, so it's read as data.
  const metadata = (discovery as OAuthDiscoveryState | null)?.authorizationServerMetadata as
    | { revocation_endpoint?: unknown }
    | undefined;
  const endpoint = metadata?.revocation_endpoint;
  if (typeof endpoint !== "string") return false;
  const fetch = oauthFetchFor(deps);
  const client = credentials.client as { client_id: string; client_secret?: string };
  const tokens = [
    ["refresh_token", credentials.tokens.refresh_token],
    ["access_token", credentials.tokens.access_token],
  ].filter((t): t is [string, string] => typeof t[1] === "string" && t[1].length > 0);
  let revoked = false;
  for (const [hint, token] of tokens) {
    const body = new URLSearchParams({ token, token_type_hint: hint });
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
    if (client.client_secret) {
      const basic = `${encodeURIComponent(client.client_id)}:${encodeURIComponent(client.client_secret)}`;
      headers.authorization = `Basic ${Buffer.from(basic, "utf8").toString("base64")}`;
    } else body.set("client_id", client.client_id);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(BUDGETS.mcp.requestMs),
      });
      await response.body?.cancel().catch(() => {});
      if (response.ok) revoked = true;
    } catch {
      // The service didn't take it; the connection is gone here all the same.
    }
  }
  return revoked;
}

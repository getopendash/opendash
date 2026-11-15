import { webOrigin } from "@/lib/slack";

/**
 * OpenDash's OAuth client metadata document (the MCP authorization spec's client ID metadata documents): an
 * authorization server that takes one fetches it and uses its address as OpenDash's client ID, with no registration.
 * Public, like any client's metadata. Only an https deployment offers it.
 */
export function GET() {
  const origin = webOrigin();
  if (!origin?.startsWith("https://")) return new Response("Not found", { status: 404 });
  return Response.json(
    {
      client_id: `${origin}/api/mcp/client`,
      client_name: "OpenDash",
      client_uri: origin,
      redirect_uris: [`${origin}/api/mcp/callback`],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    { headers: { "cache-control": "public, max-age=3600" } },
  );
}

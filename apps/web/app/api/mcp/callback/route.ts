import { mcp } from "@opendash/core";
import { tokens } from "@opendash/tokens";
import { currentTenant } from "@/lib/auth";
import { mcpDeps } from "@/lib/mcp";

/**
 * Where an MCP server's sign-in comes back: finishes it as the signed-in person, then tells the page that
 * started it. Sign-in usually runs in a window: the result goes to OpenDash's open pages (a BroadcastChannel, which
 * still works when the authorization server cut the window's link to its opener) and the window closes. When windows
 * were blocked the whole tab came here, and the page it started from (kept in sessionStorage) is opened again.
 */
export const dynamic = "force-dynamic";

type Result =
  | { state: "ready"; serverId: string; name: string; account: string | null; scope: "org" | "personal" }
  | { state: "wrong_account"; serverId: string; name: string; account: string | null; expected: string | null }
  | { state: "problem"; serverId: null; message: string };

const light = tokens.light;
const dark = tokens.dark;

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

function page(result: Result): Response {
  const title =
    result.state === "ready"
      ? `Connected to ${result.name}`
      : result.state === "wrong_account"
        ? `${result.name}: a different account`
        : "Not connected";
  const detail =
    result.state === "ready"
      ? result.account
        ? `Signed in as ${result.account}. You can close this window.`
        : "You can close this window."
      : result.state === "wrong_account"
        ? `You signed in as ${result.account ?? "another account"}, but this connection is ${result.expected ?? "a different one"}. Nothing was changed: choose in My connections.`
        : result.message;
  // Inside <script>: JSON, with "<" escaped so nothing in it can end the script.
  const payload = JSON.stringify({ type: "opendash:mcp", ...result }).replace(/</g, "\\u003c");
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · OpenDash</title>
<style>
  :root { color-scheme: light dark; --bg: ${light.background}; --fg: ${light.foreground}; --muted: ${light.muted}; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: ${dark.background}; --fg: ${dark.foreground}; --muted: ${dark.muted}; }
  }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--fg);
         font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 360px; padding: 24px; text-align: center; }
  h1 { font-size: 15px; font-weight: 600; margin: 0 0 6px; }
  p { margin: 0 0 14px; color: var(--muted); }
  a { color: inherit; }
</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p><p><a href="/settings/my-connections">Back to OpenDash</a></p></main>
<script>
(function () {
  var msg = ${payload};
  try { new BroadcastChannel("opendash-mcp").postMessage(msg); } catch (e) {}
  var back = null;
  try { back = sessionStorage.getItem("opendash-mcp-return"); sessionStorage.removeItem("opendash-mcp-return"); } catch (e) {}
  if (back && back.charAt(0) === "/" && back.charAt(1) !== "/" && back.charAt(1) !== "\\\\") {
    var sep = back.indexOf("?") < 0 ? "?" : "&";
    location.replace(back + sep + "mcp=" + encodeURIComponent(msg.state) + (msg.serverId ? "&server=" + encodeURIComponent(msg.serverId) : ""));
    return;
  }
  if (window.opener?.closed === false || window.name === "opendash-mcp") setTimeout(function () { window.close(); }, 700);
})();
</script></body></html>`;
  return new Response(html, {
    status: result.state === "problem" ? 400 : 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      // The address carried a sign-in's code and state: nothing is sent on with it.
      "referrer-policy": "no-referrer",
    },
  });
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const state = params.get("state");
  if (!state) return page({ state: "problem", serverId: null, message: "That isn't a sign-in OpenDash started." });
  const deps = mcpDeps();
  if (!deps) return page({ state: "problem", serverId: null, message: "Connections aren't set up on this server." });
  let principal: Awaited<ReturnType<typeof currentTenant>>;
  try {
    principal = await currentTenant();
  } catch {
    principal = null;
  }
  if (principal?.kind !== "session" || !principal.ctx.userId) {
    return page({
      state: "problem",
      serverId: null,
      message: "Sign in to OpenDash in this browser, then press Connect again.",
    });
  }
  try {
    const done = await mcp.finishConnect(
      deps,
      { orgId: principal.ctx.orgId, userId: principal.ctx.userId },
      { state, code: params.get("code"), iss: params.get("iss"), error: params.get("error") },
    );
    return done.state === "ready"
      ? page({
          state: "ready",
          serverId: done.server.id,
          name: done.server.name,
          account: done.account,
          scope: done.scope,
        })
      : page({
          state: "wrong_account",
          serverId: done.server.id,
          name: done.server.name,
          account: done.account,
          expected: done.expected,
        });
  } catch (error) {
    if (error instanceof mcp.McpProblem) return page({ state: "problem", serverId: null, message: error.message });
    console.error(JSON.stringify({ msg: "mcp callback failed", error: String((error as Error)?.message ?? error) }));
    return page({
      state: "problem",
      serverId: null,
      message: "Something went wrong finishing the sign-in. Try again.",
    });
  }
}

// Slack's routes, with the session, cookies and database stood in. Add to Slack: started for the admin
// with a secret their browser keeps; Slack's return, at the public address (a tunnel), checks only its own fresh
// state, uses the install once and holds the token; the browser comes back with a code, and the install connects only
// for that person, from that browser, with that code. A token OpenDash won't keep is given back, never one another
// OpenDash workspace uses. The link route keeps the token through a sign-in in an httpOnly cookie, and forgets it once
// linked; the events route handles Slack taking the app back only when Slack signed it, and records a question
// before Slack hears it arrived (a retry goes no further; one not recorded answers 500, so Slack sends it again).
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-1234");
vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("SLACK_PUBLIC_URL", "https://tunnel.example");
vi.stubEnv("SLACK_CLIENT_ID", "client-id");
vi.stubEnv("SLACK_CLIENT_SECRET", "client-secret");
vi.stubEnv("SLACK_SIGNING_SECRET", "signing-secret");

const viewer = vi.hoisted(() => ({ current: null as unknown }));
const jar = vi.hoisted(() => ({ values: new Map<string, string>() }));
const core = vi.hoisted(() => ({
  connectSlack: vi.fn(),
  slackLinkPreview: vi.fn(),
  confirmSlackLink: vi.fn(),
  slackRemovedBySlack: vi.fn(),
  connectedSlackTeam: vi.fn(async () => ({ orgId: "org-1", botUserId: "U0BOT" })),
  recordSlackInbound: vi.fn(async (): Promise<"new" | "seen"> => "new"),
  startSlackInstall: vi.fn(),
  returnSlackInstall: vi.fn(),
  holdSlackInstall: vi.fn(),
  cancelSlackInstall: vi.fn(),
  takeSlackInstall: vi.fn(),
}));
const bot = vi.hoisted(() => ({ handle: vi.fn(async () => new Response("from the bot")) }));

vi.mock("@/lib/auth", () => ({ currentViewer: async () => viewer.current }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.values.has(name) ? { value: jar.values.get(name) } : undefined),
  }),
}));
vi.mock("next/server", async (actual) => ({ ...(await actual<object>()), after: () => {} }));
vi.mock("@opendash/db", async (actual) => ({
  ...(await actual<object>()),
  withTenant: async (_ctx: unknown, fn: (tx: unknown) => Promise<unknown>) =>
    fn({ execute: async () => [{ name: "Acme" }] }),
}));
vi.mock("@opendash/core", async (actual) => ({ ...(await actual<object>()), ...core }));
vi.mock("@/lib/slack-bot", () => ({ webhookBot: () => bot }));

const { SlackInstallGone, SlackTaken } = await import("@opendash/core");
const { readInstallState, signInstallState } = await import("../lib/slack");
const { confirmSlackInstall } = await import("../lib/slack-install");
const install = await import("../app/api/slack/install/route");
const oauth = await import("../app/api/slack/oauth/route");
const link = await import("../app/api/slack/link/route");
const events = await import("../app/api/slack/events/route");

const tenant = (role = "admin") => ({
  kind: "tenant",
  user: { id: "user-1", email: "priya@acme.test", name: "Priya Raman" },
  ctx: { orgId: "org-1", userId: "user-1" },
  role,
});

/** Slack's API, by method: oauth.v2.access, auth.test, auth.revoke. */
let calls: string[] = [];
let redirectUri: string | null = null;
const slackApi = (access: Record<string, unknown>, authTest: Record<string, unknown> | null = null) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { body?: unknown }) => {
      const method = url.split("/").pop() ?? "";
      calls.push(method);
      if (method === "oauth.v2.access") redirectUri = new URLSearchParams(String(init?.body)).get("redirect_uri");
      const body =
        method === "oauth.v2.access"
          ? access
          : method === "auth.test"
            ? (authTest ?? {
                ok: true,
                team: "Acme Corp",
                team_id: "T0ACME",
                url: "https://acme.slack.com/",
                user_id: "U0BOT",
              })
            : { ok: true, revoked: true };
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
const installed = {
  ok: true,
  token_type: "bot",
  access_token: "xoxb-new",
  bot_user_id: "U0BOT",
  team: { id: "T0ACME", name: "Acme Corp" },
};
const team = { teamId: "T0ACME", teamName: "Acme Corp", teamDomain: "acme", botUserId: "U0BOT" };
const INSTALL = "01a1b2c3-0000-7000-8000-000000000001";

beforeEach(() => {
  calls = [];
  redirectUri = null;
  jar.values.clear();
  viewer.current = tenant();
  for (const f of Object.values(core)) f.mockReset();
  bot.handle.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

/** Settings → Slack's Add to Slack button: a form posted from OpenDash's own page. */
const press = (
  headers: Record<string, string> = { origin: "http://localhost:3000", "sec-fetch-site": "same-origin" },
) => install.POST(new Request("http://localhost:3000/api/slack/install", { method: "POST", headers }));
const toSettings = (response: Response) => new URL(response.headers.get("location") ?? "").searchParams.get("slack");

describe("Add to Slack", () => {
  it("starts an install for the admin, its secret kept by this browser, and sends them to Slack", async () => {
    core.startSlackInstall.mockResolvedValueOnce({ installId: INSTALL, browserSecret: "browser-secret" });
    const response = await press();
    expect(response.status).toBe(303);
    const to = new URL(response.headers.get("location") ?? "");
    expect(to.origin + to.pathname).toBe("https://slack.com/oauth/v2/authorize");
    // Slack comes back to the public address (the tunnel), not the web app's own.
    expect(to.searchParams.get("redirect_uri")).toBe("https://tunnel.example/api/slack/oauth");
    expect(readInstallState(to.searchParams.get("state") ?? "")).toMatchObject({
      orgId: "org-1",
      userId: "user-1",
      installId: INSTALL,
    });
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("opendash_slack_install=browser-secret");
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Path=\/settings\/slack/);
    // A member can't start one.
    viewer.current = tenant("member");
    expect(toSettings(await press())).toBe("unavailable");
  });

  it("starts only from OpenDash's own page: never from a link, a redirect after a sign-in link, or another site", async () => {
    // A link or redirect (a GET): sent to Settings, nothing started.
    expect(new URL((await install.GET()).headers.get("location") ?? "").pathname).toBe("/settings/slack");
    // Another site's form, a cross-site redirect chain, or no Origin at all.
    expect(toSettings(await press({ origin: "https://evil.example", "sec-fetch-site": "cross-site" }))).toBe(
      "unavailable",
    );
    expect(toSettings(await press({ origin: "http://localhost:3000", "sec-fetch-site": "cross-site" }))).toBe(
      "unavailable",
    );
    expect(toSettings(await press({}))).toBe("unavailable");
    expect(core.startSlackInstall).not.toHaveBeenCalled();
  });
});

const callback = async (state: string, extra = "code=code-1") =>
  oauth.GET(new Request(`https://tunnel.example/api/slack/oauth?${extra}&state=${encodeURIComponent(state)}`));
const back = (response: Response) => new URL(response.headers.get("location") ?? "");

describe("Slack's return", () => {
  const state = () => signInstallState({ orgId: "org-1", userId: "user-1", installId: INSTALL }).state;

  it("needs no session: its own fresh state, the install once, then the token held and the browser sent back", async () => {
    viewer.current = { kind: "signed-out" }; // the tunnel's address has no session
    slackApi(installed);
    expect(back(await callback(`${state()}x`)).searchParams.get("slack")).toBe("failed");
    core.returnSlackInstall.mockResolvedValueOnce(false); // used already, or expired
    expect(back(await callback(state())).searchParams.get("slack")).toBe("failed");
    expect(calls).toEqual([]);

    core.returnSlackInstall.mockResolvedValueOnce(true);
    core.holdSlackInstall.mockResolvedValueOnce("the-code");
    const to = back(await callback(state()));
    // Back to the web app's own address, the code in the fragment (no server log has it).
    expect(to.origin + to.pathname).toBe("http://localhost:3000/settings/slack");
    expect(to.searchParams.get("slack")).toBe("confirm");
    expect(to.hash).toBe(`#${INSTALL}.the-code`);
    expect(redirectUri).toBe("https://tunnel.example/api/slack/oauth");
    expect(core.holdSlackInstall).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "org-1",
      INSTALL,
      team,
      "xoxb-new",
    );
    expect(core.connectSlack).not.toHaveBeenCalled();
  });

  it("cancels only an install still waiting when Slack says no, and refuses an Enterprise Grid install", async () => {
    expect(back(await callback(state(), "error=access_denied")).searchParams.get("slack")).toBe("cancelled");
    expect(core.cancelSlackInstall).toHaveBeenCalledWith(expect.anything(), "org-1", INSTALL);
    // An Enterprise Grid organization-wide token is never kept anywhere: it's the one given back.
    slackApi({ ...installed, is_enterprise_install: true });
    core.returnSlackInstall.mockResolvedValueOnce(true);
    expect(back(await callback(state())).searchParams.get("slack")).toBe("enterprise");
    expect(calls).toEqual(["oauth.v2.access", "auth.revoke"]);
  });

  it("leaves alone a token Slack didn't confirm, or one whose install was replaced meanwhile", async () => {
    // Slack can hand the same bot token to another install: revoking one OpenDash won't keep could cut that off.
    slackApi(installed, { ok: false, error: "ratelimited" });
    core.returnSlackInstall.mockResolvedValueOnce(true);
    expect(back(await callback(state())).searchParams.get("slack")).toBe("failed");
    expect(calls).toEqual(["oauth.v2.access", "auth.test"]);
    calls = [];
    slackApi(installed);
    core.returnSlackInstall.mockResolvedValueOnce(true);
    core.holdSlackInstall.mockRejectedValueOnce(new SlackInstallGone());
    expect(back(await callback(state())).searchParams.get("slack")).toBe("failed");
    expect(calls).toEqual(["oauth.v2.access", "auth.test"]);
  });
});

describe("confirming it", () => {
  const me = { orgId: "org-1", userId: "user-1" };
  const input = { installId: INSTALL, code: "the-code", browserSecret: "browser-secret" };

  it("connects only what the install held for this person and browser", async () => {
    core.takeSlackInstall.mockResolvedValueOnce(null);
    expect(await confirmSlackInstall(me, input)).toBe("not_this_browser");
    expect(core.connectSlack).not.toHaveBeenCalled();
    core.takeSlackInstall.mockResolvedValueOnce({ team, token: "xoxb-new" });
    expect(await confirmSlackInstall(me, input)).toBe("connected");
    expect(core.takeSlackInstall).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), me, input);
    expect(core.connectSlack).toHaveBeenCalledWith(expect.anything(), expect.anything(), me, team, "xoxb-new");
  });

  it("says a Slack workspace is taken, here or elsewhere or in a race, and never revokes its token", async () => {
    for (const [thrown, expected] of [
      [new SlackTaken("elsewhere"), "taken"],
      [Object.assign(new Error("duplicate key"), { code: "23505" }), "taken"],
      [new SlackTaken("here"), "another_here"],
    ] as const) {
      calls = [];
      slackApi(installed);
      core.takeSlackInstall.mockResolvedValueOnce({ team, token: "xoxb-new" });
      core.connectSlack.mockRejectedValueOnce(thrown);
      expect(await confirmSlackInstall(me, input)).toBe(expected);
      expect(calls).toEqual([]);
    }
  });
});

const TOKEN = "t".repeat(32);
const post = (body: unknown) =>
  link.POST(
    new Request("https://opendash.example/api/slack/link", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(JSON.stringify(body).length) },
      body: JSON.stringify(body),
    }),
  );

describe("the link route", () => {
  it("keeps the token through a sign-in, in an httpOnly cookie only it reads, and forgets it once linked", async () => {
    viewer.current = { kind: "signed-out" };
    const signedOut = await post({ token: TOKEN });
    expect(signedOut.status).toBe(401);
    const cookie = signedOut.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`opendash_slack_link=${TOKEN}`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Path=\/api\/slack\/link/);
    expect(cookie).toMatch(/Max-Age=600/);
    expect(cookie).toMatch(/SameSite=lax/i);

    // Signed in, perhaps in another tab: the page sends no token, and the cookie's is used.
    viewer.current = tenant("member");
    jar.values.set("opendash_slack_link", TOKEN);
    core.slackLinkPreview.mockResolvedValueOnce({
      kind: "ok",
      orgId: "org-1",
      teamName: "Acme Corp",
      slackUserName: "Priya",
    });
    const preview = await post({});
    expect(await preview.json()).toMatchObject({ ok: true, preview: { teamName: "Acme Corp", workspace: "Acme" } });
    expect(core.slackLinkPreview).toHaveBeenCalledWith(expect.anything(), TOKEN, {
      orgId: "org-1",
      userId: "user-1",
      email: "priya@acme.test",
      role: "member",
    });

    core.confirmSlackLink.mockResolvedValueOnce({ kind: "linked", teamName: "Acme Corp" });
    const linked = await post({ confirm: true });
    expect(await linked.json()).toEqual({ ok: true, linked: { teamName: "Acme Corp" } });
    expect(linked.headers.get("set-cookie")).toMatch(/opendash_slack_link=;.*(Max-Age=0|Expires=Thu, 01 Jan 1970)/i);
  });

  it("says only what the checks allow: not yours, a viewer, or a link that doesn't work", async () => {
    core.slackLinkPreview.mockResolvedValueOnce({ kind: "not_yours", shown: "p•••@acme.test" });
    const notYours = await post({ token: TOKEN });
    expect(notYours.status).toBe(409);
    expect(await notYours.json()).toEqual({
      ok: false,
      reason: "not_yours",
      slackEmail: "p•••@acme.test",
      you: "priya@acme.test",
    });
    core.slackLinkPreview.mockResolvedValueOnce({ kind: "viewer" });
    expect(await (await post({ token: TOKEN })).json()).toEqual({ ok: false, reason: "viewer" });
    core.slackLinkPreview.mockResolvedValueOnce({ kind: "invalid" });
    const invalid = await post({ token: TOKEN });
    expect(invalid.status).toBe(404);
    expect(invalid.headers.get("set-cookie")).toMatch(/opendash_slack_link=;/);
    // No token at all, from the body or a cookie.
    expect((await post({})).status).toBe(404);
  });
});

const signedEvent = (payload: unknown, secret = "signing-secret") => {
  const body = JSON.stringify(payload);
  const at = Math.floor(Date.now() / 1000);
  return new Request("https://opendash.example/api/slack/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": String(at),
      "x-slack-signature": `v0=${createHmac("sha256", secret).update(`v0:${at}:${body}`).digest("hex")}`,
    },
    body,
  });
};

describe("the events route", () => {
  it("handles Slack taking the app back itself, only when Slack signed it, and hands anything else to the bot", async () => {
    const uninstalled = { type: "event_callback", team_id: "T0ACME", event: { type: "app_uninstalled" } };
    const done = await events.POST(signedEvent(uninstalled));
    expect(done.status).toBe(200);
    expect(core.slackRemovedBySlack).toHaveBeenCalledWith(expect.anything(), {
      teamId: "T0ACME",
      why: "uninstalled",
      eventTime: null,
    });
    expect(bot.handle).not.toHaveBeenCalled();

    // Signed by someone else: never handled here; the bot refuses it.
    await events.POST(signedEvent(uninstalled, "someone-else"));
    expect(core.slackRemovedBySlack).toHaveBeenCalledTimes(1);
    expect(bot.handle).toHaveBeenCalledTimes(1);

    const mention = await events.POST(
      signedEvent({ type: "event_callback", team_id: "T0ACME", event: { type: "app_mention" } }),
    );
    expect(await mention.text()).toBe("from the bot");
  });

  it("records a question before Slack hears it arrived: a retry goes no further, and one not recorded is a 500", async () => {
    const question = {
      type: "event_callback",
      team_id: "T0ACME",
      event: {
        type: "app_mention",
        user: "UPRIYA",
        channel: "C0SALES",
        ts: "1791700000.000100",
        text: "<@U0BOT> MRR?",
      },
    };
    const first = await events.POST(signedEvent(question));
    expect(await first.text()).toBe("from the bot");
    expect(core.recordSlackInbound).toHaveBeenCalledWith(
      expect.anything(),
      "org-1",
      expect.objectContaining({ key: "m:C0SALES:1791700000.000100", kind: "message" }),
      expect.any(Number),
    );
    const handled = bot.handle.mock.calls.length;
    // Slack's retry: recorded already, so answered here and not asked again.
    core.recordSlackInbound.mockResolvedValueOnce("seen");
    const retry = await events.POST(signedEvent(question));
    expect(retry.status).toBe(200);
    expect(bot.handle).toHaveBeenCalledTimes(handled);
    // Not recorded: a 500, so Slack sends it again; nothing reached the bot.
    core.recordSlackInbound.mockRejectedValueOnce(new Error("database down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failed = await events.POST(signedEvent(question));
    expect(failed.status).toBe(500);
    expect(bot.handle).toHaveBeenCalledTimes(handled);
  });

  it("reads at most 1 MiB before Slack's signature is checked, whatever the body says it is", async () => {
    const handled = bot.handle.mock.calls.length;
    const big = { type: "event_callback", event: { type: "message", text: "x".repeat(1024 * 1024) } };
    const sent = (payload: unknown, said: string | null) => {
      const r = signedEvent(payload);
      const headers = new Headers(r.headers);
      if (said === null) headers.delete("content-length");
      else headers.set("content-length", said);
      return new Request(r.url, { method: "POST", headers, body: r.body, duplex: "half" } as RequestInit);
    };
    // Said too large: refused unread, however small it is.
    expect((await events.POST(sent({ type: "event_callback" }, String(2 * 1024 * 1024)))).status).toBe(413);
    // Said nothing, or too little: read only as far as the cap.
    expect((await events.POST(sent(big, null))).status).toBe(413);
    expect((await events.POST(sent(big, "10"))).status).toBe(413);
    expect(bot.handle).toHaveBeenCalledTimes(handled);
  });
});

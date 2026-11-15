// Slack's web part: how this deployment's Slack app is set up (Add to Slack only), the OAuth state that
// only our own signed, fresh value passes, Slack's answers to auth.test and oauth.v2.access read strictly, and a token
// given back.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-1234");
const { readInstallState, signInstallState, slackOAuthAccess, slackRevoke, slackSetup, slackTeamOfToken } =
  await import("../lib/slack");

afterEach(() => {
  vi.unstubAllGlobals();
});

const env = (vars: Record<string, string>) => vars as unknown as NodeJS.ProcessEnv;
const reply = (body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));

describe("the deployment's Slack app", () => {
  it("is Add to Slack's with the app's id, secret and signing secret, over Socket Mode with an app token, or off", () => {
    const keys = { SLACK_CLIENT_ID: "1", SLACK_CLIENT_SECRET: "s", SLACK_SIGNING_SECRET: "x" };
    expect(slackSetup(env({}))).toEqual({
      kind: "off",
      missing: ["SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET", "SLACK_SIGNING_SECRET"],
      legacyToken: false,
    });
    // The old single-workspace token alone isn't a Slack app any more: it's named, so Settings can say so.
    expect(slackSetup(env({ SLACK_BOT_TOKEN: "xoxb-1", SLACK_SIGNING_SECRET: "x" }))).toEqual({
      kind: "off",
      missing: ["SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET"],
      legacyToken: true,
    });
    expect(slackSetup(env(keys))).toEqual({ kind: "oauth", socket: false });
    expect(slackSetup(env({ ...keys, SLACK_APP_TOKEN: "xapp-1" }))).toEqual({ kind: "oauth", socket: true });
  });
});

describe("the OAuth state", () => {
  it("reads back only as signed, and only while fresh", () => {
    const signed = signInstallState({ orgId: "org-1", userId: "user-1", installId: "install-1" }, 1_000);
    expect(readInstallState(signed.state, 2_000)).toEqual({
      orgId: "org-1",
      userId: "user-1",
      installId: "install-1",
      expires: 601_000,
    });
    expect(readInstallState(signed.state, 601_001)).toBeNull();
    const [payload, mac] = signed.state.split(".");
    const forged = Buffer.from(
      JSON.stringify({ orgId: "other", userId: "user-1", installId: "install-1", expires: 9e12 }),
    ).toString("base64url");
    expect(readInstallState(`${forged}.${mac}`, 2_000)).toBeNull();
    expect(readInstallState(`${payload}.`, 2_000)).toBeNull();
    expect(readInstallState("nonsense", 2_000)).toBeNull();
  });
});

describe("Slack's address", () => {
  it("is SLACK_PUBLIC_URL, else the web app's own, and only ever https", async () => {
    const { slackPublicUrl } = await import("../lib/slack");
    expect(slackPublicUrl(env({ SLACK_PUBLIC_URL: "https://tunnel.example/" }))).toBe("https://tunnel.example");
    expect(slackPublicUrl(env({ SLACK_PUBLIC_URL: "http://tunnel.example" }))).toBeNull();
    vi.stubEnv("BETTER_AUTH_URL", "https://opendash.example");
    expect(slackPublicUrl(env({}))).toBe("https://opendash.example");
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
    expect(slackPublicUrl(env({}))).toBeNull();
  });
});

describe("Slack's answers", () => {
  it("names a token's workspace and bot user, and refuses a token Slack refuses", async () => {
    vi.stubGlobal(
      "fetch",
      reply({ ok: true, team: "Acme Corp", team_id: "T0ACME", url: "https://acme.slack.com/", user_id: "U0BOT" }),
    );
    expect(await slackTeamOfToken("xoxb-1")).toEqual({
      teamId: "T0ACME",
      teamName: "Acme Corp",
      teamDomain: "acme",
      botUserId: "U0BOT",
    });
    vi.stubGlobal("fetch", reply({ ok: false, error: "invalid_auth" }));
    await expect(slackTeamOfToken("xoxb-bad")).rejects.toThrow("Slack didn't accept the app's token (invalid_auth).");
  });

  it("takes only a bot token from an OAuth exchange", async () => {
    vi.stubGlobal("fetch", reply({ ok: true, token_type: "user", access_token: "xoxp-1", team: { id: "T0ACME" } }));
    await expect(slackOAuthAccess("code", "https://opendash.example/api/slack/oauth")).rejects.toThrow(
      "Slack didn't finish installing",
    );
  });
});

describe("the app's scopes", () => {
  it("are the manifest's, nothing more", async () => {
    const { readFile } = await import("node:fs/promises");
    const { SLACK_SCOPES } = await import("../lib/slack");
    const manifest = JSON.parse(
      await readFile(new URL("../../../infra/slack/manifest.json", import.meta.url), "utf8"),
    ) as { oauth_config: { scopes: { bot: string[] } } };
    expect(manifest.oauth_config.scopes.bot).toEqual(SLACK_SCOPES);
  });
});

describe("a token given back", () => {
  it("is revoked when Slack says so, and never throws", async () => {
    vi.stubGlobal("fetch", reply({ ok: true, revoked: true }));
    expect(await slackRevoke("xoxb-1")).toBe(true);
    vi.stubGlobal("fetch", reply({ ok: false, error: "invalid_auth" }));
    expect(await slackRevoke("xoxb-1")).toBe(false);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    expect(await slackRevoke("xoxb-1")).toBe(false);
  });
});

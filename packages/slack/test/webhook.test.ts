// Slack's webhooks, as the tunnel or the cloud receives them, with no Slack: the bot answers Slack's
// address check (url_verification, sent when the manifest's address is saved) only when it's signed with the app's
// secret, so nothing but Slack reaches the handlers.
import { createHmac } from "node:crypto";
import { createMemoryState } from "@chat-adapter/state-memory";
import { describe, expect, it } from "vitest";
import { createSlackBot } from "../src";

const SECRET = "test-signing-secret";
const signed = (body: string, secret = SECRET, at = Math.floor(Date.now() / 1000)) =>
  new Request("https://opendash.example/api/slack/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": String(at),
      "x-slack-signature": `v0=${createHmac("sha256", secret).update(`v0:${at}:${body}`).digest("hex")}`,
    },
    body,
  });

describe("Slack's webhooks", () => {
  it("answer Slack's address check, and refuse what Slack didn't sign", async () => {
    const { bot } = createSlackBot(
      {
        withTenant: (async () => {
          throw new Error("no tenant in this test");
        }) as never,
        withPublic: (async () => {
          throw new Error("no database in this test");
        }) as never,
        secrets: {} as never,
        boss: async () => ({}) as never,
        deploymentKeys: {} as never,
        webUrl: "https://opendash.example",
      },
      { signingSecret: SECRET, forwardingSecret: "forwarding-secret", state: createMemoryState() },
    );
    const hook = bot.webhooks.slack;
    if (!hook) throw new Error("no Slack webhook");
    const body = JSON.stringify({ type: "url_verification", challenge: "c-123", token: "t" });

    const ok = await hook(signed(body), { waitUntil: () => {} });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("c-123");

    expect((await hook(signed(body, "someone-else"), { waitUntil: () => {} })).status).toBe(401);
    const stale = await hook(signed(body, SECRET, Math.floor(Date.now() / 1000) - 3_600), { waitUntil: () => {} });
    expect(stale.status).toBe(401);
  });
});

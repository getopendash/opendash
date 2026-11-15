// Slack's events before the bot sees them: a request Slack signed recently and only that, and the two
// events that say Slack took the app back, read from each shape a payload comes in.
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { slackRemovalOf, slackSigned } from "../src";

const SECRET = "signing-secret";
const sign = (body: string, at: number, secret = SECRET) =>
  `v0=${createHmac("sha256", secret).update(`v0:${at}:${body}`).digest("hex")}`;

describe("Slack's signature", () => {
  it("passes only the app's own, on this body, within five minutes", () => {
    const body = '{"type":"event_callback"}';
    const now = 1_792_000_000;
    expect(slackSigned(SECRET, { timestamp: String(now), signature: sign(body, now) }, body, now)).toBe(true);
    expect(slackSigned(SECRET, { timestamp: String(now), signature: sign(body, now) }, body, now + 299)).toBe(true);
    // Someone else's secret, another body, an old request, no signature, a bare secret.
    expect(slackSigned(SECRET, { timestamp: String(now), signature: sign(body, now, "x") }, body, now)).toBe(false);
    expect(slackSigned(SECRET, { timestamp: String(now), signature: sign(body, now) }, `${body} `, now)).toBe(false);
    expect(slackSigned(SECRET, { timestamp: String(now), signature: sign(body, now) }, body, now + 301)).toBe(false);
    expect(slackSigned(SECRET, { timestamp: String(now), signature: null }, body, now)).toBe(false);
    expect(slackSigned(SECRET, { timestamp: "soon", signature: sign(body, now) }, body, now)).toBe(false);
    expect(slackSigned("", { timestamp: String(now), signature: sign(body, now, "") }, body, now)).toBe(false);
  });
});

describe("Slack taking the app back", () => {
  it("is app_uninstalled, or a bot token revoked, for the team the payload names", () => {
    expect(
      slackRemovalOf({
        type: "event_callback",
        team_id: "T1",
        event_time: 1_792_000_000,
        event: { type: "app_uninstalled" },
      }),
    ).toEqual({ teamId: "T1", why: "uninstalled", eventTime: 1_792_000_000 });
    expect(
      slackRemovalOf({
        type: "event_callback",
        authorizations: [{ team_id: "T2" }],
        event: { type: "tokens_revoked", tokens: { bot: ["U0BOT"] } },
      }),
    ).toEqual({ teamId: "T2", why: "tokens_revoked", eventTime: null, botUserIds: ["U0BOT"] });
    // An Enterprise Grid organization-wide installation is never one OpenDash keeps.
    expect(
      slackRemovalOf({
        type: "event_callback",
        team_id: "T1",
        is_enterprise_install: true,
        event: { type: "app_uninstalled" },
      }),
    ).toBeNull();
    expect(
      slackRemovalOf({
        type: "event_callback",
        team_id: "T1",
        authorizations: [{ team_id: "T1", is_enterprise_install: true }],
        event: { type: "tokens_revoked", tokens: { bot: ["U0BOT"] } },
      }),
    ).toBeNull();
    // Only user tokens revoked (OpenDash holds none), another event, no team, not an event at all.
    expect(
      slackRemovalOf({
        type: "event_callback",
        team_id: "T1",
        event: { type: "tokens_revoked", tokens: { oauth: ["U1"] } },
      }),
    ).toBeNull();
    expect(slackRemovalOf({ type: "event_callback", team_id: "T1", event: { type: "app_mention" } })).toBeNull();
    expect(slackRemovalOf({ type: "event_callback", event: { type: "app_uninstalled" } })).toBeNull();
    expect(slackRemovalOf({ type: "url_verification" })).toBeNull();
    expect(slackRemovalOf(null)).toBeNull();
  });
});

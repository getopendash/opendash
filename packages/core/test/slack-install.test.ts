// Add to Slack on its way, without Slack: an install started for its admin, used once when Slack comes
// back, its token held encrypted, and taken to connect only by that person, from that browser, with the code Slack's
// return carried, while fresh; never confirmed, it's purged with its token.
import { uuidv7 } from "@opendash/db";
import { withSystemOn } from "@opendash/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cancelSlackInstall,
  dropSlackInstall,
  heldSlackInstall,
  holdSlackInstall,
  purgeSlackInstalls,
  returnSlackInstall,
  SlackInstallGone,
  startSlackInstall,
  takeSlackInstall,
} from "../src";
import { type LearnedSource, learnedSource } from "./helpers/learned-source";

let s: LearnedSource;
const team = { teamId: "T0ACME", teamName: "Acme Corp", teamDomain: "acme", botUserId: "U0BOT" };

beforeAll(async () => {
  s = await learnedSource();
}, 300_000);

afterAll(async () => {
  await s?.close();
});

const tokens = async () =>
  (
    await s.t.owner<
      { n: number }[]
    >`select count(*)::int as n from app.secret where org_id = ${s.orgId} and kind = 'oauth'`
  )[0]?.n;

describe("an Add to Slack on its way", () => {
  it("is taken only by who started it, from that browser, with Slack's code, once", async () => {
    const me = { orgId: s.orgId, userId: s.userId };
    const started = await s.tenant((tx) => startSlackInstall(tx, me));
    expect(started.browserSecret).toMatch(/^[A-Za-z0-9_-]{32}$/);
    // Slack comes back once.
    expect(await s.tenant((tx) => returnSlackInstall(tx, s.orgId, started.installId))).toBe(true);
    expect(await s.tenant((tx) => returnSlackInstall(tx, s.orgId, started.installId))).toBe(false);
    const code = await s.tenant((tx) =>
      holdSlackInstall({ secrets: s.secrets }, tx, s.orgId, started.installId, team, "xoxb-held"),
    );
    // The token is held encrypted.
    const [held] = await s.t.owner<{ ciphertext: Buffer }[]>`
      select s.ciphertext from app.secret s join app.slack_install i on i.org_id = s.org_id and i.id = ${started.installId}
      where s.id = i.secret_id`;
    expect(Buffer.from(held?.ciphertext ?? []).toString("utf8")).not.toContain("xoxb-held");

    const take = (who: { orgId: string; userId: string }, input: Partial<{ code: string; browserSecret: string }>) =>
      s.tenant((tx) =>
        takeSlackInstall({ secrets: s.secrets }, tx, who, {
          installId: started.installId,
          code,
          browserSecret: started.browserSecret,
          ...input,
        }),
      );
    // What it would connect, for the page that asks first: only for its person, browser and code.
    const ask = (who: { orgId: string; userId: string }, input: Partial<{ code: string; browserSecret: string }>) =>
      s.tenant((tx) =>
        heldSlackInstall(tx, who, {
          installId: started.installId,
          code,
          browserSecret: started.browserSecret,
          ...input,
        }),
      );
    expect(await ask(me, {})).toEqual(team);
    expect(await ask({ orgId: s.orgId, userId: uuidv7() }, {})).toBeNull();
    expect(await ask(me, { browserSecret: "another-browser-another-browser-x" })).toBeNull();
    // Slack saying no (an address anyone could replay) doesn't cancel one already held.
    await s.tenant((tx) => cancelSlackInstall(tx, s.orgId, started.installId));
    expect(await ask(me, {})).toEqual(team);

    // Another person, another browser, or without Slack's code: nothing.
    expect(await take({ orgId: s.orgId, userId: uuidv7() }, {})).toBeNull();
    expect(await take(me, { browserSecret: "another-browser-another-browser-x" })).toBeNull();
    expect(await take(me, { code: "a-code-someone-guessed-at-random-xx" })).toBeNull();
    expect(await take(me, { code: "" })).toBeNull();
    // The one who started it, from that browser, with the code: its token and team, once, and nothing left held.
    expect(await take(me, {})).toEqual({ team, token: "xoxb-held" });
    expect(await take(me, {})).toBeNull();
    expect(await tokens()).toBe(0);
  });

  it("is one at a time per person: a new one replaces the last, which can no longer hold Slack's answer", async () => {
    const me = { orgId: s.orgId, userId: s.userId };
    const first = await s.tenant((tx) => startSlackInstall(tx, me));
    await s.tenant((tx) => returnSlackInstall(tx, s.orgId, first.installId));
    const second = await s.tenant((tx) => startSlackInstall(tx, me));
    // The first one's Slack answer arrives after: nothing is held, and its token isn't kept.
    await expect(
      s.tenant((tx) => holdSlackInstall({ secrets: s.secrets }, tx, s.orgId, first.installId, team, "xoxb-late")),
    ).rejects.toBeInstanceOf(SlackInstallGone);
    expect(await tokens()).toBe(0);
    // Slack saying no cancels one still waiting.
    await s.tenant((tx) => cancelSlackInstall(tx, s.orgId, second.installId));
    expect(await s.tenant((tx) => returnSlackInstall(tx, s.orgId, second.installId))).toBe(false);
  });

  it("isn't used after 10 minutes, and is forgotten with its token when Slack says no or it's never confirmed", async () => {
    // Three people's, each their own (one person has one at a time).
    const someone = () => ({ orgId: s.orgId, userId: uuidv7() });
    const late = await s.tenant((tx) => startSlackInstall(tx, someone()));
    await s.t.owner`update app.slack_install set expires_at = now() - interval '1 minute' where id = ${late.installId}`;
    expect(await s.tenant((tx) => returnSlackInstall(tx, s.orgId, late.installId))).toBe(false);

    const cancelled = await s.tenant((tx) => startSlackInstall(tx, someone()));
    await s.tenant((tx) => returnSlackInstall(tx, s.orgId, cancelled.installId));
    await s.tenant((tx) =>
      holdSlackInstall({ secrets: s.secrets }, tx, s.orgId, cancelled.installId, team, "xoxb-cancelled"),
    );
    await s.tenant((tx) => dropSlackInstall(tx, s.orgId, cancelled.installId));
    expect(await tokens()).toBe(0);

    const abandoned = await s.tenant((tx) => startSlackInstall(tx, someone()));
    await s.tenant((tx) => returnSlackInstall(tx, s.orgId, abandoned.installId));
    await s.tenant((tx) =>
      holdSlackInstall({ secrets: s.secrets }, tx, s.orgId, abandoned.installId, team, "xoxb-abandoned"),
    );
    await s.t
      .owner`update app.slack_install set expires_at = now() - interval '2 hours' where id = ${abandoned.installId}`;
    expect(await tokens()).toBe(1);
    // Purged an hour after it expired, with its token; the one that expired a minute ago stays for now.
    expect(await purgeSlackInstalls((fn) => withSystemOn(s.t.system, fn))).toBe(1);
    expect(await tokens()).toBe(0);
    const left = await s.t.owner<{ id: string }[]>`select id from app.slack_install`;
    expect(left.map((r) => r.id)).toEqual([late.installId]);
  });
});

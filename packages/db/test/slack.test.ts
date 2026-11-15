// Slack's database: the team → workspace lookup events use before any tenant is known, who's
// asking, a link that only exists while its member does, link tokens that open once and only while fresh, a workspace
// Slack took back, and Chat SDK's state, which only the system role reaches.
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "../src/ids";
import { withSystemOn } from "../src/tenant";
import { createOrg, freshDatabase, pgError, type TestDatabase } from "./harness";

let t: TestDatabase;
const orgId = uuidv7();

beforeAll(async () => {
  t = await freshDatabase();
  await createOrg(t, orgId, "Acme");
  await withSystemOn(t.system, async (tx) => {
    await tx.execute(sql`
      insert into app.slack_workspace (org_id, team_id, team_name, bot_user_id) values (${orgId}, 'T0ACME', 'Acme Corp', 'U0BOT')`);
    await tx.execute(sql`
      insert into app.slack_link (org_id, id, team_id, slack_user_id, token_hash, expires_at, used_at) values
        (${orgId}, ${uuidv7()}, 'T0ACME', 'U1', 'open', now() + interval '10 minutes', null),
        (${orgId}, ${uuidv7()}, 'T0ACME', 'U2', 'used', now() + interval '10 minutes', now()),
        (${orgId}, ${uuidv7()}, 'T0ACME', 'U3', 'stale', now() - interval '1 minute', null)`);
  });
}, 120_000);

afterAll(async () => {
  await t?.drop();
});

describe("slack", () => {
  it("finds a team's workspace with no tenant, and nothing for a team that isn't connected", async () => {
    const found = await t.app.client<{ org_id: string; team_name: string; bot_user_id: string }[]>`
      select * from app.slack_team('T0ACME')`;
    expect(found).toEqual([expect.objectContaining({ org_id: orgId, team_name: "Acme Corp", bot_user_id: "U0BOT" })]);
    expect(await t.app.client`select * from app.slack_team('T0OTHER')`).toHaveLength(0);
    // The table itself stays closed without a tenant.
    expect(await t.app.client`select * from app.slack_workspace`).toHaveLength(0);
  });

  it("says who's asking: not connected, not linked, or a member", async () => {
    const member = uuidv7();
    await t.owner`insert into auth.user (id, name, email, email_verified) values (${member}, 'Priya', 'priya@acme.test', true)`;
    await t.owner`insert into auth.member (id, organization_id, user_id, role, created_at)
      values (${uuidv7()}, ${orgId}, ${member}, 'member', now())`;
    await withSystemOn(t.system, (tx) =>
      tx.execute(sql`
        insert into app.slack_identity (org_id, team_id, slack_user_id, user_id) values (${orgId}, 'T0ACME', 'UPRIYA', ${member})`),
    );
    const asker = (team: string, user: string) =>
      t.app.client<{ org_id: string; user_id: string | null; role: string | null }[]>`
        select * from app.slack_asker(${team}, ${user})`;
    expect(await asker("T0OTHER", "UPRIYA")).toHaveLength(0);
    expect(await asker("T0ACME", "UNEW")).toEqual([{ org_id: orgId, user_id: null, role: null }]);
    expect(await asker("T0ACME", "UPRIYA")).toEqual([{ org_id: orgId, user_id: member, role: "member" }]);
  });

  it("links only a member, one Slack account each, and unlinks them when their membership or account goes", async () => {
    const people = { kept: uuidv7(), removed: uuidv7(), deleted: uuidv7() };
    for (const [key, id] of Object.entries(people)) {
      await t.auth
        .client`insert into auth.user (id, name, email, email_verified) values (${id}, ${key}, ${`${key}@acme.test`}, true)`;
      await t.auth.client`insert into auth.member (id, organization_id, user_id, role, created_at)
        values (${uuidv7()}, ${orgId}, ${id}, 'member', now())`;
    }
    const link = (slackUserId: string, userId: string) =>
      withSystemOn(t.system, (tx) =>
        tx.execute(sql`
          insert into app.slack_identity (org_id, team_id, slack_user_id, user_id)
          values (${orgId}, 'T0ACME', ${slackUserId}, ${userId})`),
      );
    await link("UKEPT", people.kept);
    await link("UREMOVED", people.removed);
    await link("UDELETED", people.deleted);
    // Someone who isn't a member here can't be linked, and a member has one Slack account here.
    expect((await pgError(link("USTRANGER", uuidv7()))).code).toBe("23503");
    expect((await pgError(link("USECOND", people.kept))).code).toBe("23505");
    // Removed from the workspace (as Better Auth does it, as opendash_auth), or their account deleted: unlinked at once.
    await t.auth.client`delete from auth.member where organization_id = ${orgId} and user_id = ${people.removed}`;
    await t.auth.client`delete from auth.user where id = ${people.deleted}`;
    const left = await t.owner<{ slack_user_id: string }[]>`
      select slack_user_id from app.slack_identity where slack_user_id in ('UKEPT', 'UREMOVED', 'UDELETED')`;
    expect(left.map((r) => r.slack_user_id)).toEqual(["UKEPT"]);
  });

  it("keeps a workspace Slack took back as removed, with no token, and nothing else", async () => {
    const other = uuidv7();
    await createOrg(t, other, "Elsewhere");
    const insert = (removedWhy: string | null, secret = false) =>
      withSystemOn(t.system, (tx) =>
        tx.execute(sql`
          insert into app.slack_workspace (org_id, team_id, team_name, bot_user_id, removed_at, removed_why, secret_id)
          values (${other}, ${`T${uuidv7()}`}, 'Elsewhere', 'U0BOT', ${removedWhy ? sql`now()` : null}, ${removedWhy},
            ${secret ? uuidv7() : null})`),
      );
    expect((await pgError(insert("deleted"))).code).toBe("23514");
    expect((await pgError(insert("uninstalled", true))).code).toMatch(/^23/);
    await insert("uninstalled");
    const [w] = await t.owner<
      { removed_why: string }[]
    >`select removed_why from app.slack_workspace where org_id = ${other}`;
    expect(w?.removed_why).toBe("uninstalled");
  });

  it("opens a link only while it's unused and fresh", async () => {
    const open = await t.app.client<{ slack_user_id: string }[]>`select * from app.resolve_slack_link('open')`;
    expect(open.map((r) => r.slack_user_id)).toEqual(["U1"]);
    expect(await t.app.client`select * from app.resolve_slack_link('used')`).toHaveLength(0);
    expect(await t.app.client`select * from app.resolve_slack_link('stale')`).toHaveLength(0);
  });

  it("keeps Chat SDK's state to the system role", async () => {
    await t.system
      .client`insert into chat.chat_state_subscriptions (key_prefix, thread_id) values ('chat-sdk', 'slack:C1:1.2')`;
    const [row] = await t.system.client<{ n: number }[]>`select count(*)::int as n from chat.chat_state_subscriptions`;
    expect(row?.n).toBe(1);
    await expect(t.app.client`select * from chat.chat_state_subscriptions`).rejects.toThrow(
      /permission denied for schema chat/,
    );
  });
});

/**
 * Deleting a workspace and deleting an account, against a real database (as the auth role, the way the product does
 * it). The people and workspaces are the demo company's.
 */
import { uuidv7 } from "@opendash/db";
import { createOrg, freshDatabase, type TestDatabase, withSystemOn } from "@opendash/db/testing";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountDeletionPlan, deleteAccount, deleteOrganization } from "../src/deletion";

let t: TestDatabase;

async function person(name: string): Promise<string> {
  const id = uuidv7();
  await t.auth.client`
    insert into auth.user (id, name, email, email_verified)
    values (${id}, ${name}, ${`${name.toLowerCase()}.${id.slice(-6)}@acme.test`}, true)`;
  await t.auth.client`
    insert into auth.session (id, user_id, token, expires_at, created_at, updated_at)
    values (${uuidv7()}, ${id}, ${`tok-${id}`}, now() + interval '1 day', now(), now())`;
  return id;
}
async function workspace(name: string): Promise<string> {
  const id = uuidv7();
  await createOrg(t, id, name);
  return id;
}
async function join(orgId: string, userId: string, role: string): Promise<void> {
  await t.auth.client`
    insert into auth.member (id, organization_id, user_id, role, created_at)
    values (${uuidv7()}, ${orgId}, ${userId}, ${role}, now())`;
}
async function key(config: "org" | "user", referenceId: string, madeBy?: string): Promise<string> {
  const id = uuidv7();
  await t.auth.client`
    insert into auth.apikey (id, config_id, reference_id, key, enabled, created_at, updated_at, metadata)
    values (${id}, ${config}, ${referenceId}, ${`hash-${id}`}, true, now(), now(),
            ${madeBy ? JSON.stringify({ madeBy }) : null})`;
  return id;
}
const count = async (table: string, where: string, value: string) => {
  const [row] = await t.owner.unsafe<{ n: number }[]>(`select count(*)::int as n from ${table} where ${where} = $1`, [
    value,
  ]);
  return row?.n ?? 0;
};
const thread = (orgId: string, createdBy: string) =>
  withSystemOn(t.system, async (tx) => {
    const connection = uuidv7();
    await tx.execute(
      sql`insert into app.connection (org_id, id, name, dialect) values (${orgId}, ${connection}, ${`pg-${connection}`}, 'postgres')`,
    );
    await tx.execute(sql`
      insert into app.thread (org_id, id, connection_id, title, created_by)
      values (${orgId}, ${uuidv7()}, ${connection}, 'Revenue last month', ${createdBy})`);
  });

beforeAll(async () => {
  t = await freshDatabase();
});
afterAll(async () => {
  await t?.drop();
});

describe("deleting a workspace", () => {
  it("takes its members, keys, invitations and data at once, and leaves the people and other workspaces", async () => {
    const maya = await person("Maya");
    const dave = await person("Dave");
    const acme = await workspace("Acme");
    const lumen = await workspace("Lumen");
    await join(acme, maya, "owner");
    await join(acme, dave, "member");
    await join(lumen, maya, "owner");
    await key("org", acme, maya);
    const lumenKey = await key("org", lumen, maya);
    const mayaKey = await key("user", maya);
    await t.auth.client`
      insert into auth.invitation (id, organization_id, email, role, status, expires_at, inviter_id, created_at)
      values (${uuidv7()}, ${acme}, 'ines@acme.test', 'member', 'pending', now() + interval '7 days', ${maya}, now())`;
    await thread(acme, maya);
    await thread(lumen, maya);

    expect(await deleteOrganization(t.auth, acme)).toBe(true);

    expect(await count("auth.organization", "id", acme)).toBe(0);
    expect(await count("auth.member", "organization_id", acme)).toBe(0);
    expect(await count("auth.invitation", "organization_id", acme)).toBe(0);
    expect(await count("auth.apikey", "reference_id", acme)).toBe(0);
    expect(await count("app.org", "id", acme)).toBe(0);
    expect(await count("app.org_key", "org_id", acme)).toBe(0);
    expect(await count("app.thread", "org_id", acme)).toBe(0);
    expect(await count("app.org_deletion", "org_id", acme)).toBe(1);
    // The people stay, with their own keys and their other workspace whole.
    expect(await count("auth.user", "id", maya)).toBe(1);
    expect(await count("auth.user", "id", dave)).toBe(1);
    expect(await count("auth.apikey", "id", mayaKey)).toBe(1);
    expect(await count("auth.apikey", "id", lumenKey)).toBe(1);
    expect(await count("app.thread", "org_id", lumen)).toBe(1);
    expect(await count("auth.member", "organization_id", lumen)).toBe(1);

    // Asked again, or for something that isn't a workspace: nothing happens.
    expect(await deleteOrganization(t.auth, acme)).toBe(false);
    expect(await deleteOrganization(t.auth, "not-an-id")).toBe(false);
  });
});

describe("deleting an account", () => {
  it("says what would happen to each workspace before anything does", async () => {
    const maya = await person("Maya");
    const dave = await person("Dave");
    const solo = await workspace("Maya's own");
    const shared = await workspace("Shared, two owners");
    const hers = await workspace("Hers to run");
    await join(solo, maya, "owner");
    await join(shared, maya, "owner");
    await join(shared, dave, "owner");
    await join(hers, maya, "owner");
    await join(hers, dave, "member");

    const plan = await accountDeletionPlan(t.auth, maya);
    expect(plan.deleted.map((w) => w.id)).toEqual([solo]);
    expect(plan.left.map((w) => w.id)).toEqual([shared]);
    expect(plan.blocking.map((w) => w.id)).toEqual([hers]);

    // The only owner of a workspace others are in can't go: nothing is deleted.
    const refused = await deleteAccount(t.auth, maya);
    expect(refused).toMatchObject({ deleted: false, reason: "sole_owner" });
    expect(await count("auth.user", "id", maya)).toBe(1);
    expect(await count("auth.organization", "id", solo)).toBe(1);
    expect(await count("auth.member", "user_id", maya)).toBe(3);
  });

  it("takes the account, what was only theirs, and their memberships; what they made in a shared workspace stays", async () => {
    const maya = await person("Maya");
    const dave = await person("Dave");
    const solo = await workspace("Maya's own");
    const shared = await workspace("Shared");
    await join(solo, maya, "owner");
    await join(shared, maya, "owner");
    await join(shared, dave, "owner");
    await thread(solo, maya);
    await thread(shared, maya);
    const mayaKey = await key("user", maya);
    const madeByMaya = await key("org", shared, maya);
    const daveKey = await key("user", dave);
    const [row] = await t.auth.client<{ email: string }[]>`select email from auth.user where id = ${maya}`;
    const email = row?.email ?? "";
    await t.auth.client`
      insert into auth.verification (id, identifier, value, expires_at, created_at, updated_at)
      values (${uuidv7()}, 'reset-password:abc', ${maya}, now() + interval '1 hour', now(), now()),
             (${uuidv7()}, 'magic-link', ${JSON.stringify({ email, name: "Maya" })}, now() + interval '1 hour', now(), now()),
             (${uuidv7()}, 'magic-link-other', ${JSON.stringify({ email: "dave@acme.test" })}, now() + interval '1 hour', now(), now())`;
    await t.auth.client`
      insert into auth.invitation (id, organization_id, email, role, status, expires_at, inviter_id, created_at)
      values (${uuidv7()}, ${shared}, ${email.toUpperCase()}, 'member', 'pending', now() + interval '7 days', ${dave}, now())`;

    const left: string[] = [];
    const done = await deleteAccount(t.auth, maya, {
      system: (fn) => withSystemOn(t.system, fn),
      memberRemoved: async (orgId, userId) => {
        left.push(`${orgId}:${userId}`);
      },
    });
    expect(done.deleted).toBe(true);

    // The account and everything that was the person's alone.
    expect(await count("auth.user", "id", maya)).toBe(0);
    expect(await count("auth.session", "user_id", maya)).toBe(0);
    expect(await count("auth.member", "user_id", maya)).toBe(0);
    expect(await count("auth.apikey", "id", mayaKey)).toBe(0);
    expect(await count("auth.verification", "value", maya)).toBe(0);
    const [links] = await t.auth.client<{ n: number }[]>`
      select count(*)::int as n from auth.verification where identifier like 'magic-link%'`;
    expect(links?.n).toBe(1);
    expect(await count("auth.invitation", "organization_id", shared)).toBe(0);
    // A workspace only they were in goes with them, and is recorded for the purge.
    expect(await count("auth.organization", "id", solo)).toBe(0);
    expect(await count("app.thread", "org_id", solo)).toBe(0);
    expect(await count("app.org_deletion", "org_id", solo)).toBe(1);
    // The shared workspace stays, with what she made in it; an owner leaving ends its keys; the product is told.
    expect(await count("auth.organization", "id", shared)).toBe(1);
    expect(await count("app.thread", "org_id", shared)).toBe(1);
    expect(await count("auth.apikey", "id", madeByMaya)).toBe(0);
    expect(left).toEqual([`${shared}:${maya}`]);
    // The workspace she left records it, without her name.
    const audit = await t.owner<{ action: string; actor_id: string; actor_name: string }[]>`
      select action, actor_id, actor_name from app.audit_log where org_id = ${shared}`;
    expect(audit).toEqual([{ action: "member.left", actor_id: maya, actor_name: "A deleted account" }]);
    // Nobody else lost anything.
    expect(await count("auth.user", "id", dave)).toBe(1);
    expect(await count("auth.apikey", "id", daveKey)).toBe(1);
    expect(await count("auth.member", "user_id", dave)).toBe(1);

    // Asked again: there's no such account.
    expect(await deleteAccount(t.auth, maya)).toEqual({ deleted: false, reason: "not_found" });
  });
});

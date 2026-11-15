import { createHmac, randomBytes } from "node:crypto";
import { localKek } from "@opendash/core";
import { uuidv7 } from "@opendash/db";
import { createOrg, freshDatabase, type TestDatabase, withSystemOn, withTenantOn } from "@opendash/db/testing";
import { hashPassword } from "better-auth/crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type Auth, createAuth } from "../src/auth";
import { revokeUserKeys } from "../src/keys";
import { accountKey, postgresLimiter } from "../src/limits";
import { memoryMailer } from "../src/mailer";
import { assertProductionTrustedOrigins } from "../src/origins";
import { resetPasswordEmail } from "../src/previews";
import { provisionMissingOrgs, type SystemRunner } from "../src/provision";
import { turnOffTwoFactor } from "../src/recovery";
import { authRoutes, magicLinkVerifyPath } from "../src/routes";
import {
  anyAccount,
  invitationPreview,
  memberCount,
  memberNames,
  memberships,
  resolveTenant,
  resolveViewer,
  TenantAccessDenied,
} from "../src/tenant-context";

let t: TestDatabase;
let auth: Auth;
const base = "http://localhost:3000";
const kek = localKek(randomBytes(32).toString("base64"));
const mailer = memoryMailer();
const password = "correct horse battery";
const secret = randomBytes(32).toString("base64");
const defaultSecret = "better-auth-secret-12345678901234567890";

function makeAuth(overrides: Parameters<typeof createAuth>[0] = {}) {
  return createAuth({
    secret,
    database: t.auth,
    system: (fn) => withSystemOn(t.system, fn),
    kek,
    mailer,
    baseURL: base,
    // Open by default here so the fixtures can sign up; the invite-only tests pass inviteOnly: true, and the
    // default itself (on) is tested from the environment.
    inviteOnly: false,
    ...overrides,
  });
}

/** Turns Better Auth's Set-Cookie response headers into a Cookie request header. */
function cookieHeaders(set: Headers): Headers {
  const cookies = set.getSetCookie().map((c) => c.split(";")[0]);
  return new Headers({ cookie: cookies.join("; ") });
}

const mailTo = (email: string) => mailer.sent.filter((m) => m.to.toLowerCase() === email.toLowerCase());
const lastMail = (email: string) => mailTo(email).at(-1);

/** The audit log's rows for an organization, oldest first (written by audit.ts as the system role). */
const auditRows = (orgId: string) =>
  t.owner<
    {
      action: string;
      actor_id: string | null;
      actor_name: string | null;
      target_id: string | null;
      target_name: string | null;
      fields: string[];
      detail: Record<string, unknown>;
      user_agent: string | null;
    }[]
  >`select action, actor_id, actor_name, target_id, target_name, fields, detail, user_agent
    from app.audit_log where org_id = ${orgId} order by id`;

/** Asks for an email link the way the sign-up form and the invitation page do. */
async function requestLink(email: string, name?: string, via: Auth = auth) {
  await via.api.signInMagicLink({
    body: {
      email,
      name,
      callbackURL: "/",
      newUserCallbackURL: authRoutes.setPassword,
      errorCallbackURL: authRoutes.linkExpired,
    },
    headers: new Headers(),
  });
}

/** Presses the button on the Continue page the email points at, which opens the one-time link. */
async function openLink(continueUrl: string, via: Auth = auth) {
  const url = new URL(continueUrl);
  expect(url.pathname).toBe(authRoutes.continue);
  const response = await via.handler(new Request(new URL(`${magicLinkVerifyPath}${url.search}`, base)));
  return { location: response.headers.get("location") ?? "", session: cookieHeaders(response.headers) };
}

/** Ask for a link, open it, choose a password: the whole email-first sign-up. */
async function signUp(email: string, name: string) {
  await requestLink(email, name);
  const { session, location } = await openLink(lastMail(email)?.url ?? "");
  await auth.api.setPassword({ body: { newPassword: password }, headers: session });
  const userId = (await auth.api.getSession({ headers: session }))?.user.id as string;
  return { session, location, userId };
}

/** Signs up and creates a workspace, which also makes it the session's active organization. */
async function signUpWithWorkspace(email: string, name: string, orgName: string, slug: string) {
  const user = await signUp(email, name);
  const org = await auth.api.createOrganization({ body: { name: orgName, slug }, headers: user.session });
  return { ...user, orgId: org?.id as string };
}

async function unverifiedUserWithPassword(email: string, pw: string) {
  const id = uuidv7();
  await t.owner`insert into auth.user (id, name, email, email_verified) values (${id}, 'Unverified', ${email}, false)`;
  await t.owner`
    insert into auth.account (id, account_id, provider_id, user_id, password, created_at, updated_at)
    values (${uuidv7()}, ${id}, 'credential', ${id}, ${await hashPassword(pw)}, now(), now())`;
  return id;
}

const countUsers = async (email: string) =>
  (await t.owner<{ n: number }[]>`select count(*)::int as n from auth.user where lower(email) = lower(${email})`)[0]?.n;

let alice: Awaited<ReturnType<typeof signUpWithWorkspace>>;
let bob: Awaited<ReturnType<typeof signUpWithWorkspace>>;

beforeAll(async () => {
  t = await freshDatabase();
  auth = makeAuth();
  alice = await signUpWithWorkspace("Alice@Example.com", "Alice", "Acme", "acme");
  bob = await signUpWithWorkspace("bob@example.com", "Bob", "Globex", "globex");
});

afterAll(async () => {
  await t?.drop();
});

describe("email-first sign-up", () => {
  it("asking for a link creates nothing; opening it creates a verified account with no password yet", async () => {
    await requestLink("carol@example.com", "Carol");
    const mail = lastMail("carol@example.com");
    expect(mail?.kind).toBe("sign-up");
    expect(await countUsers("carol@example.com")).toBe(0);

    const { session, location } = await openLink(mail?.url ?? "");
    expect(new URL(location).pathname).toBe(authRoutes.setPassword);
    const [row] = await t.owner<{ verified: boolean; v: string; passwords: number }[]>`
      select u.email_verified as verified, substr(u.id::text, 15, 1) as v,
             (select count(*)::int from auth.account a where a.user_id = u.id and a.password is not null) as passwords
      from auth.user u where u.email = 'carol@example.com'`;
    expect(row).toEqual({ verified: true, v: "7", passwords: 0 });
    expect((await resolveViewer(auth, t.auth, session)).kind).toBe("needs-password");
  });

  it("the first password is set once, and then the account needs a workspace", async () => {
    await requestLink("dan@example.com", "Dan");
    const { session } = await openLink(lastMail("dan@example.com")?.url ?? "");
    await auth.api.setPassword({ body: { newPassword: password }, headers: session });
    await expect(
      auth.api.setPassword({ body: { newPassword: "another password" }, headers: session }),
    ).rejects.toThrow();
    expect(await resolveViewer(auth, t.auth, session)).toMatchObject({
      kind: "needs-organization",
      pendingInvitationId: null,
    });
    await expect(auth.api.signInEmail({ body: { email: "dan@example.com", password } })).resolves.toBeTruthy();
  });

  it("there is no way to sign up with a password", async () => {
    await expect(auth.api.signUpEmail({ body: { email: "eve@example.com", password, name: "Eve" } })).rejects.toThrow();
    expect(await countUsers("eve@example.com")).toBe(0);
  });

  it("an email link works once and expires after an hour", async () => {
    await requestLink("frank@example.com", "Frank");
    const [link] = await t.owner<{ minutes: number }[]>`
      select round(extract(epoch from expires_at - now()) / 60)::int as minutes
      from auth.verification where value like '%frank@example.com%' order by created_at desc limit 1`;
    expect(link?.minutes).toBe(60);
    const url = lastMail("frank@example.com")?.url ?? "";
    await openLink(url);
    const again = await openLink(url);
    expect(new URL(again.location).pathname).toBe(authRoutes.linkExpired);
    expect(new URL(again.location).searchParams.get("error")).toBe("INVALID_TOKEN");
  });

  it("someone who already has an account gets a sign-in link, not a second account", async () => {
    await requestLink("alice@example.com", "Alice again");
    const mail = lastMail("alice@example.com");
    expect(mail?.kind).toBe("sign-in");
    const { location } = await openLink(mail?.url ?? "");
    expect(new URL(location).pathname).toBe("/");
    expect(await countUsers("alice@example.com")).toBe(1);
  });

  it("a password chosen before the owner proved the address stops working once they do (pre-hijacking)", async () => {
    await unverifiedUserWithPassword("victim@corp.test", "attacker-chosen-pw");
    const attempt = () => auth.api.signInEmail({ body: { email: "victim@corp.test", password: "attacker-chosen-pw" } });
    await expect(attempt()).rejects.toThrow();

    await requestLink("victim@corp.test");
    const { session } = await openLink(lastMail("victim@corp.test")?.url ?? "");
    await expect(attempt()).rejects.toThrow();
    expect((await resolveViewer(auth, t.auth, session)).kind).toBe("needs-password");
  });

  it("signing in to an unverified account never emails a verification link, which would keep that password", async () => {
    // Better Auth's verify-email route verifies without revoking earlier access; only the email link does that.
    await unverifiedUserWithPassword("squatted@corp.test", "attacker-chosen-pw");
    await expect(
      auth.api.signInEmail({ body: { email: "squatted@corp.test", password: "attacker-chosen-pw" } }),
    ).rejects.toThrow(/verif/i);
    expect(mailTo("squatted@corp.test")).toHaveLength(0);
    expect(mailer.sent.filter((m) => (m.kind as string) === "verify-email")).toHaveLength(0);
  });
});

describe("workspaces", () => {
  it("creating an organization provisions app.org and a data key, and makes it the active workspace", async () => {
    const viewer = await resolveViewer(auth, t.auth, alice.session);
    expect(viewer).toMatchObject({ kind: "tenant", role: "owner", ctx: { orgId: alice.orgId, userId: alice.userId } });
    const rows = await t.owner<{ app_org: string | null; kek_ref: string | null }[]>`
      select a.id::text as app_org, k.kek_ref from auth.organization o
      left join app.org a on a.id = o.id
      left join app.org_key k on k.org_id = o.id and k.version = 1
      where o.id = ${alice.orgId}`;
    expect(rows[0]).toEqual({ app_org: alice.orgId, kek_ref: "local:v1" });
  });

  it("emails are stored normalized", async () => {
    const rows = await t.owner<{ email: string }[]>`select email from auth.user where id = ${alice.userId}`;
    expect(rows[0]?.email).toBe("alice@example.com");
  });

  it("the stored data key unwraps only for its own org", async () => {
    const [row] = await t.owner<{ wrapped: string }[]>`
      select wrapped_dek as wrapped from app.org_key where org_id = ${alice.orgId}`;
    await expect(kek.unwrap(row?.wrapped ?? "", `org_key:${alice.orgId}:1`)).resolves.toHaveLength(32);
    await expect(kek.unwrap(row?.wrapped ?? "", `org_key:${bob.orgId}:1`)).rejects.toThrow();
  });

  it("two orgs can't see each other's rows", async () => {
    const principal = await resolveTenant(auth, t.auth, bob.session);
    const seen = await withTenantOn(t.app, principal?.ctx ?? { orgId: "" }, (tx) =>
      tx.execute<{ id: string }>(sql`select id::text from app.org`),
    );
    expect(seen.map((r) => r.id)).toEqual([bob.orgId]);
  });

  it("no cookie, no tenant", async () => {
    expect(await resolveTenant(auth, t.auth, new Headers())).toBeNull();
    expect(await resolveViewer(auth, t.auth, new Headers())).toEqual({ kind: "signed-out" });
  });

  it("an active organization the user doesn't belong to is refused, and the web viewer is told they left it", async () => {
    const otherOrg = "01a11d00-0000-7000-8000-000000000001";
    await createOrg(t, otherOrg, "Somebody else");
    await t.owner`update auth.session set active_organization_id = ${otherOrg} where user_id = ${bob.userId}`;
    await expect(resolveTenant(auth, t.auth, bob.session)).rejects.toThrow(TenantAccessDenied);
    expect(await resolveViewer(auth, t.auth, bob.session)).toMatchObject({ kind: "left-organization" });
    await t.owner`update auth.session set active_organization_id = ${bob.orgId} where user_id = ${bob.userId}`;
  });
});

describe("organization setup", () => {
  it("auth won't start without a key-encryption key, instead of failing when the first workspace is created", () => {
    vi.stubEnv("OPENDASH_KEK", "");
    try {
      expect(() => makeAuth({ kek: undefined })).toThrow(/OPENDASH_KEK/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("if the product side can't be set up, the organization is undone and the name can be used again", async () => {
    const { session } = await signUp("olive@example.com", "Olive");
    const broken = makeAuth({
      kek: { ref: "broken", wrap: () => Promise.reject(new Error("KMS unavailable")), unwrap: kek.unwrap },
    });
    await expect(
      broken.api.createOrganization({ body: { name: "Olive Co", slug: "olive-co" }, headers: session }),
    ).rejects.toThrow();
    const left = await t.owner<
      { n: number }[]
    >`select count(*)::int as n from auth.organization where slug = 'olive-co'`;
    expect(left[0]?.n).toBe(0);
    expect((await resolveViewer(auth, t.auth, session)).kind).toBe("needs-organization");
    const org = await auth.api.createOrganization({ body: { name: "Olive Co", slug: "olive-co" }, headers: session });
    expect(org?.slug).toBe("olive-co");
  });

  it("the repair finishes organizations left without app.org, and is safe to run again", async () => {
    const id = uuidv7();
    await t.owner`insert into auth.organization (id, name, slug, created_at) values (${id}, 'Stranded', 'stranded', now())`;
    const system: SystemRunner = (fn) => withSystemOn(t.system, fn);
    const deps = { database: t.auth, kek, system };
    expect(await provisionMissingOrgs(deps)).toEqual(["stranded"]);
    const [row] = await t.owner<{ keys: number }[]>`
      select count(*)::int as keys from app.org o join app.org_key k on k.org_id = o.id where o.id = ${id}`;
    expect(row?.keys).toBe(1);
    expect(await provisionMissingOrgs(deps)).toEqual([]);
  });
});

describe("invitations", () => {
  let invitationId: string;

  it("the invitation email points at the invitation page, which shows only what's needed", async () => {
    const invitation = await auth.api.createInvitation({
      body: { email: "gina@example.com", role: "member", organizationId: alice.orgId },
      headers: alice.session,
    });
    invitationId = invitation?.id as string;
    // A week to accept, as the members page and the email say.
    expect(new Date(invitation?.expiresAt as Date).getTime() - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
    expect(lastMail("gina@example.com")).toMatchObject({ kind: "invitation", url: `${base}/invite/${invitationId}` });
    expect(await invitationPreview(t.auth, invitationId)).toEqual({
      id: invitationId,
      email: "gina@example.com",
      role: "member",
      organization: { id: alice.orgId, name: "Acme", slug: "acme", members: 1 },
      inviter: { name: "Alice", email: "alice@example.com" },
    });
    expect(await invitationPreview(t.auth, uuidv7())).toBeNull();
    expect(await invitationPreview(t.auth, "not-a-uuid")).toBeNull();
  });

  it("a new invitee signs up from it, chooses a password and joins the organization", async () => {
    await requestLink("gina@example.com", "Gina");
    const { session } = await openLink(lastMail("gina@example.com")?.url ?? "");
    await auth.api.setPassword({ body: { newPassword: password }, headers: session });
    expect(await resolveViewer(auth, t.auth, session)).toMatchObject({
      kind: "needs-organization",
      pendingInvitationId: invitationId,
    });
    await auth.api.acceptInvitation({ body: { invitationId }, headers: session });
    expect(await resolveViewer(auth, t.auth, session)).toMatchObject({
      kind: "tenant",
      role: "member",
      ctx: { orgId: alice.orgId },
    });
    expect(await invitationPreview(t.auth, invitationId)).toBeNull();
  });

  it("names an organization's members, and nobody from another one", async () => {
    const [gina] = await t.owner<{ id: string }[]>`select id from auth."user" where email = 'gina@example.com'`;
    const ginaId = gina?.id as string;
    expect(await memberNames(t.auth, alice.orgId, [alice.userId, ginaId, bob.userId])).toEqual({
      [alice.userId]: "Alice",
      [ginaId]: "Gina",
    });
    expect(await memberNames(t.auth, bob.orgId, [alice.userId, ginaId])).toEqual({});
    expect(await memberNames(t.auth, alice.orgId, ["not-a-uuid"])).toEqual({});
    // Nameless (signed up by an email link): the address stands in, except where it mustn't (a public link).
    await t.owner`update auth."user" set name = '' where id = ${ginaId}`;
    expect(await memberNames(t.auth, alice.orgId, [ginaId])).toEqual({ [ginaId]: "gina@example.com" });
    expect(await memberNames(t.auth, alice.orgId, [ginaId], { emailWhenNameless: false })).toEqual({});
    await t.owner`update auth."user" set name = 'Gina' where id = ${ginaId}`;
  });

  it("lists someone's workspaces by name and counts a workspace's members, for the app, which can't read them", async () => {
    const mine = await memberships(t.auth, alice.userId);
    expect(mine.map((o) => o.id)).toContain(alice.orgId);
    expect(mine.map((o) => o.id)).not.toContain(bob.orgId);
    expect(mine.map((o) => o.name)).toEqual([...mine.map((o) => o.name)].sort((a, b) => a.localeCompare(b)));
    const [{ n } = { n: 0 }] = await t.owner<{ n: number }[]>`
      select count(*)::int as n from auth.member where organization_id = ${alice.orgId}`;
    expect(await memberCount(t.auth, alice.orgId)).toBe(n);
    expect(await memberships(t.auth, "not-a-uuid")).toEqual([]);
  });

  it("an expired invitation is replaced with a new week: cancelled, then sent again", async () => {
    const first = await auth.api.createInvitation({
      body: { email: "ines@example.com", role: "viewer", organizationId: alice.orgId },
      headers: alice.session,
    });
    const id = first?.id as string;
    await t.owner`update auth.invitation set expires_at = now() - interval '1 day' where id = ${id}`;
    // What the members page's Resend does for an expired row.
    await auth.api.cancelInvitation({ body: { invitationId: id }, headers: alice.session });
    const again = await auth.api.createInvitation({
      body: { email: "ines@example.com", role: "viewer", organizationId: alice.orgId, resend: true },
      headers: alice.session,
    });
    expect(again?.id).not.toBe(id);
    expect(new Date(again?.expiresAt as Date).getTime() - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
    const rows = await t.owner<{ status: string }[]>`
      select status from auth.invitation where email = 'ines@example.com' order by created_at`;
    expect(rows.map((r) => r.status)).toEqual(["canceled", "pending"]);
  });

  it("someone with a different email can't accept it", async () => {
    const invitation = await auth.api.createInvitation({
      body: { email: "hana@example.com", role: "member", organizationId: alice.orgId },
      headers: alice.session,
    });
    await expect(
      auth.api.acceptInvitation({ body: { invitationId: invitation?.id as string }, headers: bob.session }),
    ).rejects.toThrow();
  });
});

describe("API keys", () => {
  it("an org-owned key acts as its organization", async () => {
    const created = await auth.api.createApiKey({
      body: { configId: "org", organizationId: alice.orgId, userId: alice.userId, name: "ci" },
    });
    expect(created.key.startsWith("odo_")).toBe(true);
    const principal = await resolveTenant(auth, t.auth, new Headers({ "x-api-key": created.key }));
    expect(principal).toMatchObject({ kind: "org_api_key", ctx: { orgId: alice.orgId, userId: null } });
  });

  it("a user-owned key needs X-Org-Id and a membership in that org", async () => {
    const created = await auth.api.createApiKey({ body: { configId: "user", userId: bob.userId, name: "laptop" } });
    expect(created.key.startsWith("odu_")).toBe(true);
    const asBob = await resolveTenant(auth, t.auth, new Headers({ "x-api-key": created.key, "x-org-id": bob.orgId }));
    expect(asBob).toMatchObject({ kind: "user_api_key", ctx: { orgId: bob.orgId, userId: bob.userId } });
    await expect(
      resolveTenant(auth, t.auth, new Headers({ "x-api-key": created.key, "x-org-id": alice.orgId })),
    ).rejects.toThrow(/Not a member/);
    await expect(resolveTenant(auth, t.auth, new Headers({ "x-api-key": created.key }))).rejects.toThrow(/X-Org-Id/);
  });

  it("a forged key is refused", async () => {
    await expect(resolveTenant(auth, t.auth, new Headers({ "x-api-key": "odo_not-a-real-key" }))).rejects.toThrow(
      TenantAccessDenied,
    );
  });

  it("every key expires after 90 days, and nobody can give one another life", async () => {
    const created = await auth.api.createApiKey({ body: { configId: "user", userId: bob.userId, name: "ninety" } });
    const days = (new Date(created.expiresAt ?? 0).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(89.9);
    expect(days).toBeLessThan(90.1);
    await expect(
      auth.api.createApiKey({ body: { configId: "user", userId: bob.userId, name: "a year", expiresIn: 31_536_000 } }),
    ).rejects.toThrow(/Custom key expiration values are disabled/);
    // Updating it to never expire is refused too.
    await expect(
      auth.api.updateApiKey({ body: { configId: "user", keyId: created.id, userId: bob.userId, expiresIn: null } }),
    ).rejects.toThrow(/Custom key expiration values are disabled/);
    const [row] = await t.owner<
      { expires_at: Date | null }[]
    >`select expires_at from auth.apikey where id = ${created.id}`;
    expect(row?.expires_at).not.toBeNull();
  });

  it("an account's recovery ends the org keys it made, and only those", async () => {
    const w = await twoOwners("made-by");
    const theirs = await auth.api.createApiKey({
      body: { configId: "org", organizationId: w.first.orgId, userId: w.second.userId, name: "theirs" },
    });
    const still = async (id: string) =>
      Boolean((await t.owner<{ id: string }[]>`select id from auth.apikey where id = ${id}`)[0]);
    expect(await still(theirs.id)).toBe(true);
    // The second owner's account is recovered: the key they made goes, the first owner's stays.
    await revokeUserKeys(t.auth.db, w.second.userId);
    expect(await still(theirs.id)).toBe(false);
    expect(await w.resolves()).toBe(true);
  });

  it("a key made while a reset signs out the session that asked for it goes too", async () => {
    const lee = await signUp("lee@example.com", "Lee");
    // A reset committing between the key's insert and the check after it, played by a trigger on the insert.
    await t.owner.unsafe(`
      create function auth.test_reset_on_key() returns trigger language plpgsql as $$
      begin delete from auth.session where user_id = new.reference_id; return new; end $$;
      create trigger test_reset_on_key after insert on auth.apikey for each row execute function auth.test_reset_on_key();`);
    try {
      const response = await auth.handler(
        new Request(new URL("/api/auth/api-key/create", base), {
          method: "POST",
          headers: new Headers({
            ...Object.fromEntries(lee.session),
            "content-type": "application/json",
            origin: base,
          }),
          body: JSON.stringify({ configId: "user", name: "raced" }),
        }),
      );
      expect(response.status).toBe(200);
    } finally {
      await t.owner.unsafe(`drop trigger test_reset_on_key on auth.apikey; drop function auth.test_reset_on_key();`);
    }
    const [left] = await t.owner<{ n: number }[]>`
      select count(*)::int as n from auth.apikey where config_id = 'user' and reference_id = ${lee.userId}`;
    expect(left?.n).toBe(0);
  });

  it("a key made while the operator's reset is still committing waits for it, then goes", async () => {
    const mei = await signUp("mei@example.com", "Mei");
    const keys = async () =>
      (
        await t.owner<{ n: number }[]>`
          select count(*)::int as n from auth.apikey where config_id = 'user' and reference_id = ${mei.userId}`
      )[0]?.n;
    let created: Promise<Response> | undefined;
    // The reset's transaction has deleted the sessions and keys but not committed: the key is written meanwhile, and
    // its check must wait for the commit rather than see the session still there.
    await t.owner.begin(async (tx) => {
      await tx`delete from auth.session where user_id = ${mei.userId}`;
      created = auth.handler(
        new Request(new URL("/api/auth/api-key/create", base), {
          method: "POST",
          headers: new Headers({
            ...Object.fromEntries(mei.session),
            "content-type": "application/json",
            origin: base,
          }),
          body: JSON.stringify({ configId: "user", name: "waited" }),
        }),
      );
      // Wait until the request blocks on this transaction. Only waits in this test's database count: other packages'
      // tests share the server, and a wait of theirs would end the loop before the key is written.
      for (let i = 0; i < 100; i += 1) {
        const [w] = await tx<{ n: number }[]>`
          select count(*)::int as n from pg_locks l join pg_stat_activity a on a.pid = l.pid
          where not l.granted and a.datname = current_database()`;
        if (w?.n) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      // Read on the transaction's own connection: it sees the key the request committed.
      const [k] = await tx<{ n: number }[]>`
        select count(*)::int as n from auth.apikey where config_id = 'user' and reference_id = ${mei.userId}`;
      expect(k?.n).toBe(1);
    });
    expect((await created)?.status).toBe(200);
    expect(await keys()).toBe(0);
  });

  /** A workspace with two owners, each signed in, and one org key, for the revocation cases. */
  async function twoOwners(tag: string) {
    const first = await signUpWithWorkspace(`${tag}-one@example.com`, "One", `Org ${tag}`, `org-${tag}`);
    const second = await signUp(`${tag}-two@example.com`, "Two");
    await t.owner`
      insert into auth.member (id, organization_id, user_id, role, created_at)
      values (${uuidv7()}, ${first.orgId}, ${second.userId}, 'owner', now())`;
    const key = await auth.api.createApiKey({
      body: { configId: "org", organizationId: first.orgId, userId: first.userId, name: "ci" },
    });
    const [m] = await t.owner<{ id: string }[]>`
      select id from auth.member where organization_id = ${first.orgId} and user_id = ${second.userId}`;
    const resolves = () =>
      resolveTenant(auth, t.auth, new Headers({ "x-api-key": key.key })).then(
        () => true,
        () => false,
      );
    return { first, second, memberId: m?.id as string, resolves };
  }

  it("an owner removed from the workspace ends its org keys", async () => {
    const w = await twoOwners("removed");
    expect(await w.resolves()).toBe(true);
    await auth.api.removeMember({
      body: { memberIdOrEmail: w.memberId, organizationId: w.first.orgId },
      headers: w.first.session,
    });
    expect(await w.resolves()).toBe(false);
  });

  it("an owner demoted to admin ends its org keys", async () => {
    const w = await twoOwners("demoted");
    await auth.api.updateMemberRole({
      body: { memberId: w.memberId, role: "admin", organizationId: w.first.orgId },
      headers: w.first.session,
    });
    expect(await w.resolves()).toBe(false);
  });

  it("an owner who leaves ends its org keys", async () => {
    const w = await twoOwners("leaves");
    await auth.api.setActiveOrganization({ body: { organizationId: w.first.orgId }, headers: w.second.session });
    await auth.handler(
      new Request(new URL("/api/auth/organization/leave", base), {
        method: "POST",
        headers: new Headers({
          ...Object.fromEntries(w.second.session),
          "content-type": "application/json",
          origin: base,
        }),
        body: JSON.stringify({ organizationId: w.first.orgId }),
      }),
    );
    const [left] = await t.owner<{ n: number }[]>`
      select count(*)::int as n from auth.member where organization_id = ${w.first.orgId} and user_id = ${w.second.userId}`;
    expect(left?.n).toBe(0);
    expect(await w.resolves()).toBe(false);
  });

  it("a workspace can't be deleted through Better Auth: nothing is removed, and its keys stay with its members", async () => {
    const w = await twoOwners("deleted");
    const response = await auth.handler(
      new Request(new URL("/api/auth/organization/delete", base), {
        method: "POST",
        headers: new Headers({
          ...Object.fromEntries(w.first.session),
          "content-type": "application/json",
          origin: base,
        }),
        body: JSON.stringify({ organizationId: w.first.orgId }),
      }),
    );
    expect(response.status).toBe(404);
    const [members] = await t.owner<{ n: number }[]>`
      select count(*)::int as n from auth.member where organization_id = ${w.first.orgId}`;
    expect(members?.n).toBe(2);
    expect(await w.resolves()).toBe(true);
  });

  it("tells the product a membership ended, removed or leaving, and a failure there doesn't undo it", async () => {
    const ended: [string, string][] = [];
    const told = makeAuth({
      memberRemoved: async (orgId, userId) => {
        ended.push([orgId, userId]);
        if (ended.length === 1) throw new Error("the product was down");
      },
    });
    const w = await twoOwners("told");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await told.api.removeMember({
        body: { memberIdOrEmail: w.memberId, organizationId: w.first.orgId },
        headers: w.first.session,
      });
    } finally {
      errors.mockRestore();
    }
    expect(ended).toEqual([[w.first.orgId, w.second.userId]]);
    const [gone] = await t.owner<{ n: number }[]>`
      select count(*)::int as n from auth.member where organization_id = ${w.first.orgId} and user_id = ${w.second.userId}`;
    expect(gone?.n).toBe(0);
    // Leaving, too.
    await t.owner`
      insert into auth.member (id, organization_id, user_id, role, created_at)
      values (${uuidv7()}, ${w.first.orgId}, ${w.second.userId}, 'member', now())`;
    await told.api.setActiveOrganization({ body: { organizationId: w.first.orgId }, headers: w.second.session });
    await told.handler(
      new Request(new URL("/api/auth/organization/leave", base), {
        method: "POST",
        headers: new Headers({
          ...Object.fromEntries(w.second.session),
          "content-type": "application/json",
          origin: base,
        }),
        body: JSON.stringify({ organizationId: w.first.orgId }),
      }),
    );
    expect(ended).toEqual([
      [w.first.orgId, w.second.userId],
      [w.first.orgId, w.second.userId],
    ]);
  });

  it("a member who isn't an owner leaving keeps the org's keys", async () => {
    const w = await twoOwners("member-left");
    await t.owner`update auth.member set role = 'member' where id = ${w.memberId}`;
    await auth.api.removeMember({
      body: { memberIdOrEmail: w.memberId, organizationId: w.first.orgId },
      headers: w.first.session,
    });
    expect(await w.resolves()).toBe(true);
  });
});

describe("invite-only registration", () => {
  it("is on unless OPENDASH_INVITE_ONLY=0", async () => {
    vi.stubEnv("OPENDASH_INVITE_ONLY", "");
    await requestLink("stranger@example.com", "Stranger", makeAuth({ inviteOnly: undefined }));
    expect(mailTo("stranger@example.com")).toHaveLength(0);
    vi.stubEnv("OPENDASH_INVITE_ONLY", "0");
    await requestLink("stranger@example.com", "Stranger", makeAuth({ inviteOnly: undefined }));
    expect(mailTo("stranger@example.com")).toHaveLength(1);
    vi.unstubAllEnvs();
  });

  it("a new invite-only instance takes its first sign-up, then only invitations", async () => {
    const empty = await freshDatabase();
    try {
      const closed = makeAuth({
        database: empty.auth,
        system: (fn) => withSystemOn(empty.system, fn),
        inviteOnly: true,
      });
      expect(await anyAccount(empty.auth)).toBe(false);
      await requestLink("first@example.com", "First", closed);
      // Until someone has an account, a second person can ask too; whoever opens their link first is in.
      await requestLink("also@example.com", "Also", closed);
      const { location } = await openLink(lastMail("first@example.com")?.url ?? "", closed);
      expect(new URL(location).pathname).toBe(authRoutes.setPassword);
      expect(await anyAccount(empty.auth)).toBe(true);
      const late = await openLink(lastMail("also@example.com")?.url ?? "", closed);
      expect(new URL(late.location).searchParams.get("error")).toBe("REGISTRATION_REQUIRES_INVITATION");
      await requestLink("next@example.com", "Next", closed);
      expect(mailTo("next@example.com")).toHaveLength(0);
      const accounts = await empty.owner<{ email: string }[]>`select email from auth.user`;
      expect(accounts.map((a) => a.email)).toEqual(["first@example.com"]);
    } finally {
      await empty.drop();
    }
  });

  it("no link is sent to an uninvited email", async () => {
    await requestLink("mallory@example.com", "Mallory", makeAuth({ inviteOnly: true }));
    expect(mailTo("mallory@example.com")).toHaveLength(0);
  });

  it("a link opened after registration closed creates nothing and lands on the link-expired page", async () => {
    await requestLink("late@example.com", "Late");
    const { location } = await openLink(lastMail("late@example.com")?.url ?? "", makeAuth({ inviteOnly: true }));
    expect(new URL(location).pathname).toBe(authRoutes.linkExpired);
    expect(new URL(location).searchParams.get("error")).toBe("REGISTRATION_REQUIRES_INVITATION");
    expect(await countUsers("late@example.com")).toBe(0);
  });

  it("an invited email gets a link and can register", async () => {
    const closed = makeAuth({ inviteOnly: true });
    await auth.api.createInvitation({
      body: { email: "ivan@example.com", role: "member", organizationId: alice.orgId },
      headers: alice.session,
    });
    await requestLink("Ivan@Example.com", "Ivan", closed);
    const { location } = await openLink(lastMail("ivan@example.com")?.url ?? "", closed);
    expect(new URL(location).pathname).toBe(authRoutes.setPassword);
    expect(await countUsers("ivan@example.com")).toBe(1);
  });

  it("an expired invitation doesn't count", async () => {
    await auth.api.createInvitation({
      body: { email: "judy@example.com", role: "member", organizationId: alice.orgId },
      headers: alice.session,
    });
    await t.owner`update auth.invitation set expires_at = now() - interval '1 minute' where email = 'judy@example.com'`;
    await requestLink("judy@example.com", "Judy", makeAuth({ inviteOnly: true }));
    expect(mailTo("judy@example.com").filter((m) => m.kind === "sign-up")).toHaveLength(0);
  });

  it("a member of an invite-only instance can create another organization", async () => {
    const closed = makeAuth({ inviteOnly: true });
    await expect(
      closed.api.createOrganization({
        body: { name: "Acme Labs", slug: "acme-labs", keepCurrentActiveOrganization: true },
        headers: alice.session,
      }),
    ).resolves.toBeTruthy();
  });
});

describe("rate limiting", () => {
  const signIn = (via: Auth, ip: string, email: string, pw = "not the password") =>
    via.handler(
      new Request(`${base}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: base, "x-forwarded-for": ip },
        body: JSON.stringify({ email, password: pw }),
      }),
    );
  const linkRequest = (via: Auth, ip: string, email: string) =>
    via.handler(
      new Request(`${base}/api/auth/sign-in/magic-link`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: base, "x-forwarded-for": ip },
        body: JSON.stringify({ email, callbackURL: "/" }),
      }),
    );
  let n = 0;
  /** A fresh documentation-range IP for every call (198.18.0.0/15). */
  const freshIp = () => {
    n += 1;
    return `198.${18 + Math.floor(n / 65000)}.${Math.floor(n / 250) % 250}.${(n % 250) + 1}`;
  };
  const statusCounts = (statuses: number[]) =>
    statuses.reduce<Record<number, number>>((acc, s) => {
      acc[s] = (acc[s] ?? 0) + 1;
      return acc;
    }, {});

  it("per IP: a fourth sign-in attempt within 10 seconds is refused, counted in Postgres", async () => {
    const limited = makeAuth({ rateLimit: true });
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await signIn(limited, "203.0.113.7", "alice@example.com")).status);
    expect(statuses).toEqual([401, 401, 401, 429]);
    expect((await signIn(limited, "198.51.100.9", "alice@example.com")).status).toBe(401);
    const [row] = await t.owner<{ n: number }[]>`select count(*)::int as n from auth.rate_limit where key like 'ip:%'`;
    expect(row?.n).toBeGreaterThan(0);
  });

  it("per account and IP: one place can't keep guessing, and the owner still signs in from elsewhere", async () => {
    const limited = makeAuth({ rateLimit: true });
    // Server-side calls skip the per-IP layer, so this reaches the account's per-IP limit (10 per 15 minutes).
    const attempt = () => limited.api.signInEmail({ body: { email: "dan@example.com", password: "wrong one" } });
    for (let i = 0; i < 10; i++) await expect(attempt()).rejects.toMatchObject({ statusCode: 401 });
    await expect(attempt()).rejects.toMatchObject({ statusCode: 429 });
    expect((await signIn(limited, freshIp(), "dan@example.com", password)).status).toBe(200);
  });

  it("parallel guesses can't slip past: 60 at once from 60 IPs get exactly 50 tries", async () => {
    const limited = makeAuth({ rateLimit: true });
    const statuses = await Promise.all(
      Array.from({ length: 60 }, () => signIn(limited, freshIp(), "victim2@example.com").then((r) => r.status)),
    );
    expect(statusCounts(statuses)).toEqual({ 401: 50, 429: 10 });
  });

  it("past the account backstop, password sign-in pauses but the owner can still get an email link", async () => {
    const limited = makeAuth({ rateLimit: true });
    for (let i = 0; i < 50; i++) await signIn(limited, freshIp(), "bob@example.com");
    expect((await signIn(limited, freshIp(), "bob@example.com", password)).status).toBe(429);
    expect((await linkRequest(limited, freshIp(), "bob@example.com")).status).toBe(200);
    expect(lastMail("bob@example.com")?.kind).toBe("sign-in");
  });

  it("a successful sign-in clears that account's counters", async () => {
    const limited = makeAuth({ rateLimit: true });
    for (let i = 0; i < 20; i++) await signIn(limited, freshIp(), "kim2@example.com");
    const key = (
      await t.owner<{ c: number }[]>`
      select count::int as c from auth.rate_limit where key = ${accountKey("signIn", "dan@example.com")}`
    )[0];
    expect(key).toBeUndefined();
    const [kim] = await t.owner<{ c: number }[]>`
      select count::int as c from auth.rate_limit where key = ${accountKey("signIn", "kim2@example.com")}`;
    expect(kim?.c).toBe(20);
  });

  it("email links: 6 per address per IP, 30 per address overall", async () => {
    const limited = makeAuth({ rateLimit: true });
    const fromOne = [];
    for (let i = 0; i < 7; i++) {
      fromOne.push(
        await limited.api
          .signInMagicLink({ body: { email: "flood@example.com", callbackURL: "/" }, headers: new Headers() })
          .then(() => 200)
          .catch((e: { statusCode?: number }) => e.statusCode ?? 500),
      );
    }
    expect(fromOne).toEqual([200, 200, 200, 200, 200, 200, 429]);
    const spread = [];
    for (let i = 0; i < 25; i++) spread.push((await linkRequest(limited, freshIp(), "flood@example.com")).status);
    expect(statusCounts(spread)).toEqual({ 200: 24, 429: 1 });
  });

  it("requests whose IP can't be trusted share one strict bucket: no opting out of the per-IP limit", async () => {
    // In production Better Auth keys them "no-trusted-ip|<path>" (tests fall back to 127.0.0.1, so this checks the
    // store directly). A forged multi-entry X-Forwarded-For lands here instead of getting a fresh bucket.
    const store = postgresLimiter(t.auth).betterAuthStorage;
    const rule = { window: 10, max: 3 };
    const decisions = [];
    for (let i = 0; i < 4; i++) decisions.push((await store.consume("no-trusted-ip|/sign-in/email", rule)).allowed);
    expect(decisions).toEqual([true, true, true, false]);
  });
});

describe("email delivery", () => {
  it("a failing email provider doesn't fail the request, and the log doesn't name the address", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const failing = makeAuth({ mailer: { send: () => Promise.reject(new Error("provider down")) } });
      await expect(
        failing.api.requestPasswordReset({
          body: { email: "alice@example.com", redirectTo: authRoutes.resetPassword },
        }),
      ).resolves.toMatchObject({ status: true });
      await expect(requestLink("someone-new@example.com", "New", failing)).resolves.toBeUndefined();
      await vi.waitFor(() => expect(errors).toHaveBeenCalledTimes(2));
      const logged = errors.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("auth email failed");
      expect(logged).toContain("provider down");
      expect(logged).not.toContain("@example.com");
    } finally {
      errors.mockRestore();
    }
  });
});

describe("password reset", () => {
  it("never reveals whether an account exists", async () => {
    await expect(
      auth.api.requestPasswordReset({ body: { email: "nobody@example.com", redirectTo: authRoutes.resetPassword } }),
    ).resolves.toMatchObject({ status: true });
    expect(mailTo("nobody@example.com")).toHaveLength(0);
  });

  it("the link works for an hour, sets the password, signs out every session and revokes the API keys", async () => {
    const kim = await signUp("kim@example.com", "Kim");
    await auth.api.createApiKey({ body: { configId: "user", userId: kim.userId, name: "borrowed" } });
    const keys = async () =>
      (
        await t.owner<{ n: number }[]>`
          select count(*)::int as n from auth.apikey where config_id = 'user' and reference_id = ${kim.userId}`
      )[0]?.n;
    expect(await keys()).toBe(1);
    await auth.api.requestPasswordReset({ body: { email: "kim@example.com", redirectTo: authRoutes.resetPassword } });
    const mail = lastMail("kim@example.com");
    expect(mail?.kind).toBe("reset-password");
    const token = new URL(mail?.url ?? "").pathname.split("/").at(-1) ?? "";
    const [row] = await t.owner<{ minutes: number }[]>`
      select round(extract(epoch from expires_at - now()) / 60)::int as minutes
      from auth.verification where identifier = ${`reset-password:${token}`}`;
    expect(row?.minutes).toBe(60);
    expect(await resetPasswordEmail(t.auth, token)).toBe("kim@example.com");
    expect(await resetPasswordEmail(t.auth, "not-a-token")).toBeNull();

    await auth.api.resetPassword({ body: { newPassword: "a brand new password", token } });
    expect(await resetPasswordEmail(t.auth, token)).toBeNull();
    expect(await auth.api.getSession({ headers: kim.session })).toBeNull();
    expect(await keys()).toBe(0);
    await expect(
      auth.api.signInEmail({ body: { email: "kim@example.com", password: "a brand new password" } }),
    ).resolves.toBeTruthy();
  });
});

/** An HS256 JWT shaped like Better Auth's email-verification token. */
function verificationToken(email: string, key: string): string {
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const body = `${part({ alg: "HS256" })}.${part({ email, iat: now, exp: now + 3600 })}`;
  return `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
}

describe("auth secret", () => {
  it("is required in every environment, and Better Auth's public default is refused", () => {
    // `undefined` falls back to the environment; keep a developer's sourced .env out of it.
    vi.stubEnv("BETTER_AUTH_SECRET", "");
    try {
      for (const bad of [undefined, "", "too-short", defaultSecret]) {
        expect(() => makeAuth({ secret: bad })).toThrow(/BETTER_AUTH_SECRET/);
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("a verification link signed with the public default secret doesn't verify the email", async () => {
    await unverifiedUserWithPassword("erin@example.com", "erin's password");
    const verified = async () =>
      (await t.owner<{ v: boolean }[]>`select email_verified as v from auth.user where email = 'erin@example.com'`)[0]
        ?.v;
    await expect(
      auth.api.verifyEmail({ query: { token: verificationToken("erin@example.com", defaultSecret) } }),
    ).rejects.toThrow();
    expect(await verified()).toBe(false);
    // Control: the same token signed with the real secret does verify, so only the key differs.
    await auth.api.verifyEmail({ query: { token: verificationToken("erin@example.com", secret) } });
    expect(await verified()).toBe(true);
  });
});

describe("production origin rules", () => {
  it("accept exact HTTPS origins and reject anything looser", () => {
    expect(() => assertProductionTrustedOrigins(["https://app.example.com"])).not.toThrow();
    for (const bad of ["http://app.example.com", "https://*.example.com", "https://app.example.com/path", ""]) {
      expect(() => assertProductionTrustedOrigins([bad])).toThrow();
    }
  });
});

describe("two-factor", () => {
  /** RFC 6238 with the authenticator app's defaults (SHA-1, 6 digits, 30 s), from the key in the QR code's URI. */
  function totp(uri: string, at = Date.now()) {
    const key = new URL(uri).searchParams.get("secret") ?? "";
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let bits = "";
    for (const ch of key.replace(/=+$/, "").toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, "0");
    const bytes = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => Number.parseInt(b, 2)));
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
    const mac = createHmac("sha1", bytes).update(counter).digest();
    const offset = (mac[mac.length - 1] as number) & 0xf;
    return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
  }

  /** A browser's request to the auth server: JSON, from the app's origin, with its cookies. */
  async function post(path: string, body: unknown, cookies: Headers = new Headers()) {
    const headers = new Headers(cookies);
    headers.set("content-type", "application/json");
    headers.set("origin", base);
    const response = await auth.handler(
      new Request(new URL(`/api/auth${path}`, base), { method: "POST", headers, body: JSON.stringify(body) }),
    );
    return { response, json: (await response.json().catch(() => null)) as Record<string, unknown> | null };
  }
  /** Cookies a browser keeps from a response, merged over the ones it had. */
  function keep(had: Headers, response: Response): Headers {
    const jar = new Map(
      (had.get("cookie") ?? "")
        .split("; ")
        .filter(Boolean)
        .map((c) => c.split("=") as [string, string]),
    );
    for (const set of response.headers.getSetCookie()) {
      const [pair, ...attrs] = set.split(";");
      const [name, ...value] = (pair as string).split("=");
      if (attrs.some((a) => /max-age=0/i.test(a))) jar.delete(name as string);
      else jar.set(name as string, value.join("="));
    }
    return new Headers({ cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") });
  }
  const signedIn = async (cookies: Headers) => (await auth.api.getSession({ headers: cookies }))?.user ?? null;

  let carol: Awaited<ReturnType<typeof signUpWithWorkspace>>;
  let uri = "";
  let backupCodes: string[] = [];

  beforeAll(async () => {
    carol = await signUpWithWorkspace("carol@example.com", "Carol", "Initech", "initech");
  });

  it("is turned on with the password, then a code from the app; nothing changes until the code", async () => {
    expect((await post("/two-factor/enable", { password: "wrong password!" }, carol.session)).response.status).toBe(
      400,
    );
    const { json } = await post("/two-factor/enable", { password }, carol.session);
    uri = String(json?.totpURI);
    backupCodes = json?.backupCodes as string[];
    expect(uri).toMatch(/^otpauth:\/\/totp\/OpenDash:carol%40example\.com\?/);
    expect(backupCodes).toHaveLength(10);
    // Typed from paper: lowercase, no look-alikes (i, l, o, 0, 1), five and five.
    for (const c of backupCodes) expect(c).toMatch(/^[a-hjkmnp-z2-9]{5}-[a-hjkmnp-z2-9]{5}$/);
    // Not on yet: a password sign-in still goes straight in.
    const before = await post("/sign-in/email", { email: "carol@example.com", password });
    expect(before.json?.twoFactorRedirect).toBeUndefined();
    expect((await post("/two-factor/verify-totp", { code: "000000" }, carol.session)).response.status).toBe(401);
    const confirmed = await post("/two-factor/verify-totp", { code: totp(uri) }, carol.session);
    expect(confirmed.response.status).toBe(200);
    carol.session = keep(carol.session, confirmed.response);
    expect((await signedIn(carol.session))?.twoFactorEnabled).toBe(true);
  });

  it("asks for the code after the password, and refuses a wrong one", async () => {
    const first = await post("/sign-in/email", { email: "carol@example.com", password });
    expect(first.json).toEqual({ twoFactorRedirect: true, twoFactorMethods: ["totp"] });
    const pending = keep(new Headers(), first.response);
    expect(await signedIn(pending)).toBeNull();
    expect((await post("/two-factor/verify-totp", { code: "123456" }, pending)).response.status).toBe(401);
    const done = await post("/two-factor/verify-totp", { code: totp(uri) }, pending);
    expect(done.response.status).toBe(200);
    expect((await signedIn(keep(pending, done.response)))?.email).toBe("carol@example.com");
  });

  it("takes a backup code instead, once", async () => {
    const code = backupCodes[0] as string;
    const first = await post("/sign-in/email", { email: "carol@example.com", password });
    const pending = keep(new Headers(), first.response);
    const done = await post("/two-factor/verify-backup-code", { code }, pending);
    expect(done.response.status).toBe(200);
    expect(await signedIn(keep(pending, done.response))).not.toBeNull();
    const again = keep(
      new Headers(),
      (await post("/sign-in/email", { email: "carol@example.com", password })).response,
    );
    expect((await post("/two-factor/verify-backup-code", { code }, again)).response.status).toBe(401);
  });

  it("skips the code on a device trusted for 30 days", async () => {
    const first = await post("/sign-in/email", { email: "carol@example.com", password });
    let browser = keep(new Headers(), first.response);
    const done = await post("/two-factor/verify-totp", { code: totp(uri), trustDevice: true }, browser);
    browser = keep(browser, done.response);
    const trust = done.response.headers.getSetCookie().find((c) => c.includes("trust_device"));
    expect(trust).toMatch(/Max-Age=2592000/i);
    const next = await post("/sign-in/email", { email: "carol@example.com", password }, browser);
    expect(next.json?.twoFactorRedirect).toBeUndefined();
    expect(await signedIn(keep(browser, next.response))).not.toBeNull();
  });

  it("sends an email link to the code page instead of signing in, keeping only a path on this site", async () => {
    const open = async (callbackURL: string) => {
      await auth.api.signInMagicLink({
        body: { email: "carol@example.com", callbackURL, errorCallbackURL: authRoutes.linkExpired },
        headers: new Headers(),
      });
      const link = new URL(lastMail("carol@example.com")?.url ?? "");
      return auth.handler(new Request(new URL(`${magicLinkVerifyPath}${link.search}`, base)));
    };
    for (const [callbackURL, next] of [
      ["/invite/123", "/invite/123"],
      // On this site but not a path: the code page goes home.
      [`${base}/ask`, "/"],
    ] as const) {
      const response = await open(callbackURL);
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(`${authRoutes.twoFactor}?next=${encodeURIComponent(next)}`);
      const pending = keep(new Headers(), response);
      expect(await signedIn(pending)).toBeNull();
      const done = await post("/two-factor/verify-totp", { code: totp(uri) }, pending);
      expect(done.response.status).toBe(200);
      expect((await signedIn(keep(pending, done.response)))?.email).toBe("carol@example.com");
    }
    // Elsewhere: Better Auth refuses the link before anything else runs.
    const elsewhere = await open("//evil.example");
    expect(elsewhere.status).toBe(403);
    expect(await signedIn(keep(new Headers(), elsewhere))).toBeNull();
    // An account without two-factor still goes where the link points.
    await requestLink("bob@example.com");
    expect((await openLink(lastMail("bob@example.com")?.url ?? "")).location).toBe(`${base}/`);
  });

  it("is turned off by the deployment's operator for someone who lost the app and the codes", async () => {
    const trusted = await post("/sign-in/email", { email: "carol@example.com", password });
    let browser = keep(new Headers(), trusted.response);
    browser = keep(
      browser,
      (await post("/two-factor/verify-totp", { code: totp(uri), trustDevice: true }, browser)).response,
    );
    expect(await signedIn(browser)).not.toBeNull();
    const key = await auth.api.createApiKey({ body: { configId: "user", userId: carol.userId, name: "laptop" } });
    expect(await turnOffTwoFactor(t.auth, "nobody@example.com")).toEqual({ found: false });
    const off = await turnOffTwoFactor(t.auth, " Carol@Example.com ");
    expect(off).toMatchObject({ found: true, wasOn: true, keys: 1 });
    if (!off.found) throw new Error("not found");
    expect(off.sessions).toBeGreaterThan(0);
    // The key made with a session someone may have borrowed goes with the sessions.
    await expect(
      resolveTenant(auth, t.auth, new Headers({ "x-api-key": key.key, "x-org-id": carol.orgId })),
    ).rejects.toThrow();
    // Signed out everywhere, and no browser is trusted any more.
    expect(await signedIn(browser)).toBeNull();
    expect(await signedIn(carol.session)).toBeNull();
    const [left] = await t.owner<{ n: number }[]>`
      select count(*)::int as n from auth.verification v join auth.user u on u.id::text = v.value
      where lower(u.email) = 'carol@example.com' and v.identifier like 'trust-device-%'`;
    expect(left?.n).toBe(0);
    const plain = await post("/sign-in/email", { email: "carol@example.com", password });
    expect(plain.json?.twoFactorRedirect).toBeUndefined();
    // Back on, for the next test: the password, then a code.
    carol.session = keep(new Headers(), plain.response);
    const again = await post("/two-factor/enable", { password }, carol.session);
    uri = String(again.json?.totpURI);
    carol.session = keep(
      carol.session,
      (await post("/two-factor/verify-totp", { code: totp(uri) }, carol.session)).response,
    );
    expect((await signedIn(carol.session))?.twoFactorEnabled).toBe(true);
  });

  it("is turned off with the password, and then the password is enough", async () => {
    expect((await post("/two-factor/disable", { password: "wrong password!" }, carol.session)).response.status).toBe(
      400,
    );
    const off = await post("/two-factor/disable", { password }, carol.session);
    expect(off.response.status).toBe(200);
    const plain = await post("/sign-in/email", { email: "carol@example.com", password });
    expect(plain.json?.twoFactorRedirect).toBeUndefined();
    expect(await signedIn(keep(new Headers(), plain.response))).not.toBeNull();
  });

  it("leaves the audit log its two-factor changes and sign-ins, in Carol's workspace", async () => {
    const actions = (await auditRows(carol.orgId)).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["two_factor.enabled", "two_factor.disabled", "signin.succeeded"]));
    const viaCode = (await auditRows(carol.orgId)).filter(
      (r) => r.action === "signin.succeeded" && (r.detail as { method?: string }).method === "two_factor",
    );
    expect(viaCode.length).toBeGreaterThan(0);
  });
});

describe("the audit log", () => {
  it("records a password sign-in, with the browser, in every workspace of the person", async () => {
    await auth.api.signInEmail({
      body: { email: "alice@example.com", password },
      headers: new Headers({ "user-agent": "Firefox/140" }),
    });
    const [row] = (await auditRows(alice.orgId)).filter((r) => r.action === "signin.succeeded").slice(-1);
    expect(row).toMatchObject({
      actor_id: alice.userId,
      actor_name: "Alice",
      user_agent: "Firefox/140",
      detail: { method: "password" },
    });
    expect(
      (await auditRows(bob.orgId)).some((r) => r.action === "signin.succeeded" && r.actor_id === alice.userId),
    ).toBe(false);
  });

  it("records an email-link sign-in", async () => {
    await requestLink("alice@example.com");
    await openLink(lastMail("alice@example.com")?.url ?? "");
    const [row] = (await auditRows(alice.orgId)).filter((r) => r.action === "signin.succeeded").slice(-1);
    expect(row).toMatchObject({ actor_id: alice.userId, detail: { method: "email_link" } });
  });

  it("records a refused sign-in for the account it named", async () => {
    await expect(
      auth.api.signInEmail({ body: { email: "alice@example.com", password: "not the password" } }),
    ).rejects.toThrow();
    const [row] = (await auditRows(alice.orgId)).filter((r) => r.action === "signin.failed").slice(-1);
    expect(row).toMatchObject({ actor_id: alice.userId, detail: { method: "password", reason: "bad_credentials" } });
  });

  it("records an invitation, a role change and a removal, with who did them", async () => {
    const invited = await auth.api.createInvitation({
      body: { email: "hal@example.com", role: "viewer", organizationId: alice.orgId },
      headers: alice.session,
    });
    const hal = await signUp("hal-audit@example.com", "Hal");
    await t.owner`insert into auth.member (id, organization_id, user_id, role, created_at)
      values (${uuidv7()}, ${alice.orgId}, ${hal.userId}, 'member', now())`;
    const [m] = await t.owner<{ id: string }[]>`
      select id from auth.member where organization_id = ${alice.orgId} and user_id = ${hal.userId}`;
    await auth.api.updateMemberRole({
      body: { memberId: m?.id as string, role: "admin", organizationId: alice.orgId },
      headers: alice.session,
    });
    await auth.api.removeMember({
      body: { memberIdOrEmail: m?.id as string, organizationId: alice.orgId },
      headers: alice.session,
    });
    const rows = await auditRows(alice.orgId);
    expect(rows.find((r) => r.action === "member.invited" && r.target_id === invited?.id)).toMatchObject({
      actor_name: "Alice",
      target_name: "hal@example.com",
      detail: { role: "viewer" },
    });
    expect(rows.find((r) => r.action === "member.role_changed" && r.target_id === hal.userId)).toMatchObject({
      actor_id: alice.userId,
      target_name: "Hal",
      fields: ["role"],
      detail: { from: "member", to: "admin" },
    });
    expect(rows.find((r) => r.action === "member.removed" && r.target_id === hal.userId)).toMatchObject({
      actor_id: alice.userId,
      detail: { role: "admin" },
    });
  });

  it("records an org key made and revoked, by name, and keys an owner's removal ended", async () => {
    const key = await auth.api.createApiKey({
      body: { configId: "org", organizationId: alice.orgId, name: "deploy" },
      headers: alice.session,
    });
    await auth.api.deleteApiKey({ body: { configId: "org", keyId: key.id }, headers: alice.session });
    const rows = await auditRows(alice.orgId);
    expect(rows.find((r) => r.action === "api_key.created" && r.target_id === key.id)).toMatchObject({
      actor_id: alice.userId,
      target_name: "deploy",
      detail: { owner: "organization" },
    });
    expect(rows.find((r) => r.action === "api_key.revoked" && r.target_id === key.id)).toMatchObject({
      actor_id: alice.userId,
      target_name: "deploy",
      detail: { owner: "organization", count: 1 },
    });
  });

  it("never writes a secret: no row carries a password, a key or a token", async () => {
    const all = await t.owner<{ row: string }[]>`select row_to_json(a)::text as row from app.audit_log a`;
    for (const { row } of all) {
      expect(row).not.toContain(password);
      expect(row).not.toMatch(/odo_|odu_/);
    }
  });
});

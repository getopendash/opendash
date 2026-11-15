// Directory sync end to end: the real auth server with ee/'s extensions, a fresh database, and the requests Okta and
// Microsoft Entra send (from their documentation), replayed with the workspace's token.
import { randomBytes } from "node:crypto";
import { type Auth, combineExtensions, createAuth, memoryMailer } from "@opendash/auth";
import { createOrgSealer, localKek } from "@opendash/core";
import type { EnterpriseScim, SsoCaller } from "@opendash/core/enterprise";
import { type TenantTx, uuidv7 } from "@opendash/db";
import { freshDatabase, type TestDatabase, withSystemOn, withTenantOn } from "@opendash/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { directorySync } from "../src/scim";
import { singleSignOn } from "../src/sso";

const base = "http://localhost:3000";
const kek = localKek(randomBytes(32).toString("base64"));
const mailer = memoryMailer();
let licensed = true;
let t: TestDatabase;
let auth: Auth;
let scim: EnterpriseScim;
let orgId: string;
let token = "";
let mayaHeaders: Headers;

const USER = "urn:ietf:params:scim:schemas:core:2.0:User";
const GROUP = "urn:ietf:params:scim:schemas:core:2.0:Group";
const PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

/** A directory's request, as Okta or Entra sends it: a bearer token, no cookie, no Origin. */
async function directory(method: string, path: string, body?: unknown, bearer = token) {
  const res = await auth.handler(
    new Request(`${base}/api/auth/scim/v2${path}`, {
      method,
      headers: {
        authorization: `Bearer ${bearer}`,
        accept: "application/scim+json",
        ...(body ? { "content-type": "application/scim+json" } : {}),
        "user-agent": "Okta SCIM Client 1.0.0",
      },
      body: body ? JSON.stringify(body) : undefined,
    }),
  );
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
}

/** Okta's POST /Users body. */
const oktaUser = (email: string, given: string, family: string) => ({
  schemas: [USER],
  userName: email,
  name: { givenName: given, familyName: family },
  emails: [{ primary: true, value: email, type: "work" }],
  displayName: `${given} ${family}`,
  locale: "en-US",
  externalId: `00u${randomBytes(6).toString("hex")}`,
  groups: [],
  password: "1mz050nq",
  active: true,
});

async function caller(): Promise<SsoCaller> {
  const s = await auth.api.getSession({ headers: mayaHeaders });
  if (!s) throw new Error("not signed in");
  return { orgId, userId: s.user.id, sessionId: s.session.id, role: "owner", headers: mayaHeaders };
}

const userOf = async (email: string) =>
  (
    await t.owner<{ id: string; email_verified: boolean }[]>`
      select id, email_verified from auth."user" where lower(email) = ${email.toLowerCase()}`
  )[0];
const roleOf = async (userId: string | undefined) =>
  (
    await t.owner<{ role: string }[]>`
      select role from auth.member where user_id = ${userId ?? uuidv7()} and organization_id = ${orgId}`
  )[0]?.role;
const rows = async () =>
  t.owner<{ action: string; actor_type: string; target_name: string | null; detail: Record<string, unknown> }[]>`
    select action, actor_type, target_name, detail from app.audit_log where org_id = ${orgId} order by id`;

beforeAll(async () => {
  t = await freshDatabase();
  const sealer = createOrgSealer({ kek, run: (org, fn) => withTenantOn(t.app, { orgId: org }, fn) });
  const shared = {
    database: t.auth,
    origin: base,
    auth: () => auth,
    tenant: <T>(ctx: { orgId: string; userId: string }, fn: (tx: TenantTx) => Promise<T>) =>
      withTenantOn(t.app, ctx, fn),
    gate: () => ({ canChange: () => licensed }),
  };
  const sso = singleSignOn({ ...shared, sealer, system: (fn) => withSystemOn(t.system, fn) });
  const sync = directorySync(shared);
  scim = sync.manage;
  auth = createAuth({
    secret: randomBytes(32).toString("base64"),
    database: t.auth,
    system: (fn) => withSystemOn(t.system, fn),
    kek,
    mailer,
    baseURL: base,
    inviteOnly: true,
    extension: combineExtensions(sso.auth, sync.auth),
  });
  const signIn = async () => {
    await auth.api.signInMagicLink({ body: { email: "maya@acme.test", callbackURL: "/" }, headers: new Headers() });
    const link = new URL(mailer.sent.at(-1)?.url ?? "");
    const res = await auth.handler(new Request(`${base}/api/auth/magic-link/verify${link.search}`));
    return new Headers({
      cookie: res.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; "),
    });
  };
  mayaHeaders = await signIn();
  const org = await auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers: mayaHeaders });
  orgId = org?.id as string;
  mayaHeaders = await signIn();
}, 60_000);

afterAll(async () => {
  await t?.drop();
});

describe("connecting a directory", () => {
  it("needs a verified single sign-on domain, then gives a token once", async () => {
    expect(await scim.connect(await caller())).toMatchObject({ ok: false, code: "NO_DOMAIN" });
    // As single sign-on's verification leaves it: the workspace's claim on its domain.
    await t.owner`insert into auth.sso_domain (domain, organization_id) values ('acme.test', ${orgId})`;
    const connected = await scim.connect(await caller());
    expect(connected.ok).toBe(true);
    if (!connected.ok) return;
    token = connected.value.token;
    expect(token.length).toBeGreaterThan(20);
    const status = await scim.status(await caller());
    expect(status).toMatchObject({ connected: true, domains: ["acme.test"], baseUrl: `${base}/api/auth/scim/v2` });
    expect(await scim.connect(await caller())).toMatchObject({ ok: false, code: "CONNECTED" });
    // Only its digest is stored.
    const stored = JSON.stringify(await t.owner`select * from auth.scim_managed_credential`);
    expect(stored).not.toContain(token);
  });
});

describe("Okta's requests", () => {
  it("adds someone at the verified domain as a verified viewer, with no password", async () => {
    const found = await directory(
      "GET",
      `/Users?filter=${encodeURIComponent('userName eq "priya@acme.test"')}&startIndex=1&count=100`,
    );
    expect(found).toMatchObject({ status: 200, json: { totalResults: 0 } });
    const made = await directory("POST", "/Users", oktaUser("priya@acme.test", "Priya", "Shah"));
    expect(made.status).toBe(201);
    const priya = await userOf("priya@acme.test");
    expect(priya?.email_verified).toBe(true);
    expect(await roleOf(priya?.id)).toBe("viewer");
    const accounts = await t.owner`select provider_id from auth.account where user_id = ${priya?.id as string}`;
    expect(accounts).toEqual([]);
    const joined = (await rows()).find((r) => r.action === "member.joined");
    expect(joined).toMatchObject({ actor_type: "scim", detail: { role: "viewer" } });
  });

  it("refuses someone outside the workspace's verified domains", async () => {
    const res = await directory("POST", "/Users", oktaUser("bob@lumen.test", "Bob", "Lind"));
    expect(res.status).toBe(403);
    expect(await userOf("bob@lumen.test")).toBeUndefined();
    expect((await rows()).some((r) => r.action === "scim.refused" && r.target_name === "bob@lumen.test")).toBe(true);
  });

  it("links someone who already has an account there, keeping a role set by hand", async () => {
    const ines = uuidv7();
    await t.auth
      .client`insert into auth."user" (id, name, email, email_verified) values (${ines}, 'Ines', 'ines@acme.test', true)`;
    await t.auth.client`insert into auth.member (id, organization_id, user_id, role, created_at)
      values (${uuidv7()}, ${orgId}, ${ines}, 'member', now())`;
    const res = await directory("POST", "/Users", oktaUser("ines@acme.test", "Ines", "Moreau"));
    expect(res.status).toBe(201);
    const users = await t.owner`select id from auth."user" where lower(email) = 'ines@acme.test'`;
    expect(users.length).toBe(1);
    expect(await roleOf(ines)).toBe("member");
  });

  it("gives a mapped group's role, and takes it back when the person leaves the group", async () => {
    const group = await directory("POST", "/Groups", { schemas: [GROUP], displayName: "IT admins", members: [] });
    expect(group.status).toBe(201);
    const groupId = String(group.json.id);
    const priya = await userOf("priya@acme.test");
    const listed = await directory("GET", `/Users?filter=${encodeURIComponent('userName eq "priya@acme.test"')}`);
    const priyaScim = (listed.json.Resources as { id: string }[])[0]?.id;
    const add = await directory("PATCH", `/Groups/${groupId}`, {
      schemas: [PATCH],
      Operations: [{ op: "add", path: "members", value: [{ value: priyaScim, display: "priya@acme.test" }] }],
    });
    expect([200, 204]).toContain(add.status);
    expect(await roleOf(priya?.id)).toBe("viewer");
    const status = await scim.status(await caller());
    expect(status.groups).toEqual([{ groupId, name: "IT admins", members: 1, role: null }]);
    expect(await scim.mapGroup(await caller(), groupId, "admin")).toEqual({ ok: true, value: null });
    expect(await roleOf(priya?.id)).toBe("admin");
    const remove = await directory("PATCH", `/Groups/${groupId}`, {
      schemas: [PATCH],
      Operations: [{ op: "remove", path: `members[value eq "${priyaScim}"]` }],
    });
    expect([200, 204]).toContain(remove.status);
    expect(await roleOf(priya?.id)).toBe("viewer");
    const audit = await rows();
    expect(audit.some((r) => r.action === "scim.mapping_updated" && r.target_name === "IT admins")).toBe(true);
    expect(audit.some((r) => r.action === "member.role_changed" && r.detail.to === "admin")).toBe(true);
    expect(audit.some((r) => r.action === "member.role_changed" && r.detail.to === "viewer")).toBe(true);
  });

  it("deactivating someone ends their membership and their sessions", async () => {
    const priya = await userOf("priya@acme.test");
    await t.auth.client`insert into auth.session (id, token, user_id, expires_at, created_at, updated_at)
      values (${uuidv7()}, ${randomBytes(16).toString("hex")}, ${priya?.id as string}, now() + interval '1 day', now(), now())`;
    const listed = await directory("GET", `/Users?filter=${encodeURIComponent('userName eq "priya@acme.test"')}`);
    const id = (listed.json.Resources as { id: string }[])[0]?.id;
    const off = await directory("PATCH", `/Users/${id}`, {
      schemas: [PATCH],
      Operations: [{ op: "replace", value: { active: false } }],
    });
    expect(off.status).toBe(200);
    expect(await roleOf(priya?.id)).toBeUndefined();
    expect((await t.owner`select 1 from auth.session where user_id = ${priya?.id as string}`).length).toBe(0);
    expect((await rows()).some((r) => r.action === "member.removed" && r.actor_type === "scim")).toBe(true);
  });

  it("keeps the workspace's last owner when the directory removes them, and says so", async () => {
    const made = await directory("POST", "/Users", oktaUser("maya@acme.test", "Maya", "Chen"));
    expect(made.status).toBe(201);
    const maya = await userOf("maya@acme.test");
    expect(await roleOf(maya?.id)).toBe("owner");
    const gone = await directory("DELETE", `/Users/${made.json.id}`);
    expect(gone.status).toBe(204);
    expect(await roleOf(maya?.id)).toBe("owner");
    expect((await rows()).some((r) => r.action === "scim.owner_kept")).toBe(true);
    // Deactivated everywhere the directory knows them, so signed out (the plugin's rule), and back in by email.
    expect(await auth.api.getSession({ headers: mayaHeaders })).toBeNull();
    await auth.api.signInMagicLink({ body: { email: "maya@acme.test", callbackURL: "/" }, headers: new Headers() });
    const link = new URL(mailer.sent.at(-1)?.url ?? "");
    const back = await auth.handler(new Request(`${base}/api/auth/magic-link/verify${link.search}`));
    mayaHeaders = new Headers({
      cookie: back.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; "),
    });
    expect((await auth.api.getSession({ headers: mayaHeaders }))?.user.email).toBe("maya@acme.test");
  });
});

describe("Microsoft Entra's requests", () => {
  it('creates a group with its legacy schema marker, adds a member with "Add", and disables with "Replace"', async () => {
    const user = await directory("POST", "/Users", {
      schemas: [USER, "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User"],
      externalId: "0a21f0f2-8d2a-4f8e-bf98-7363c4aed4ef",
      userName: "sam@acme.test",
      active: true,
      emails: [{ primary: true, type: "work", value: "sam@acme.test" }],
      meta: { resourceType: "User" },
      name: { formatted: "Sam Okafor", familyName: "Okafor", givenName: "Sam" },
      roles: [],
    });
    expect(user.status).toBe(201);
    const group = await directory("POST", "/Groups", {
      schemas: [GROUP, "http://schemas.microsoft.com/2006/11/ResourceManagement/ADSCIM/2.0/Group"],
      externalId: "8aa1a0c0-c4c3-4bc0-b4a5-2ef676900159",
      displayName: "Data team",
      meta: { resourceType: "Group" },
    });
    expect(group.status).toBe(201);
    expect(await scim.mapGroup(await caller(), String(group.json.id), "member")).toEqual({ ok: true, value: null });
    const add = await directory("PATCH", `/Groups/${group.json.id}`, {
      schemas: [PATCH],
      Operations: [{ op: "Add", path: "members", value: [{ $ref: null, value: user.json.id }] }],
    });
    expect([200, 204]).toContain(add.status);
    const sam = await userOf("sam@acme.test");
    expect(await roleOf(sam?.id)).toBe("member");
    const off = await directory("PATCH", `/Users/${user.json.id}`, {
      Operations: [{ op: "Replace", path: "active", value: false }],
      schemas: [PATCH],
    });
    expect(off.status).toBe(200);
    expect(await roleOf(sam?.id)).toBeUndefined();
  });
});

describe("tokens", () => {
  it("a new token ends the old one; disconnecting ends every token and keeps the people", async () => {
    const before = await directory("GET", "/Users?startIndex=1&count=1");
    expect(before.status).toBe(200);
    const rotated = await scim.rotate(await caller());
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) return;
    expect((await directory("GET", "/Users?count=1", undefined, token)).status).toBe(401);
    token = rotated.value.token;
    expect((await directory("GET", "/Users?count=1")).status).toBe(200);
    const ines = await userOf("ines@acme.test");
    // Without a license, the directory's access can still be taken away.
    licensed = false;
    expect(await scim.connect(await caller())).toMatchObject({ ok: false, code: "LICENSE_REQUIRED" });
    expect(await scim.disconnect(await caller())).toMatchObject({ ok: true, value: { tokensRevoked: 1 } });
    licensed = true;
    expect((await directory("GET", "/Users?count=1")).status).toBe(401);
    expect(await roleOf(ines?.id)).toBe("member");
    expect((await scim.status(await caller())).connected).toBe(false);
    // Connecting again gives the same connection a new token.
    const again = await scim.connect(await caller());
    expect(again.ok).toBe(true);
    if (again.ok) expect((await directory("GET", "/Users?count=1", undefined, again.value.token)).status).toBe(200);
    const actions = (await rows()).map((r) => r.action);
    for (const a of ["scim.connected", "scim.token_rotated", "scim.disconnected"]) expect(actions).toContain(a);
  });
});

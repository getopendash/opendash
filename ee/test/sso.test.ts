// Single sign-on end to end: the real auth server with ee/'s extension, a fresh database, and a stub OpenID Connect
// provider in this process, so the plugin's real callback runs and the hooks that decide who may be created, linked,
// stamped and refused run on their real paths. Invite-only is on, as in production: an SSO arrival is let in by the SSO
// exception, not by the ordinary rule.
import { randomBytes } from "node:crypto";
import { type Auth, createAuth, memoryMailer } from "@opendash/auth";
import { createOrgSealer, localKek } from "@opendash/core";
import type { EnterpriseSso, SsoCaller } from "@opendash/core/enterprise";
import { uuidv7 } from "@opendash/db";
import { freshDatabase, type TestDatabase, withSystemOn, withTenantOn } from "@opendash/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { singleSignOn } from "../src/sso";
import { resetSessionGuard } from "../src/sso/guard";
import { ssoSecretCodec } from "../src/sso/sealed-adapter";
import { enforcedProviderForDomain, forgetProviderCaches } from "../src/sso/store";
import { samlMetadata } from "./saml-fixture";
import { STUB_CLIENT_SECRET, type StubIdp, startStubIdp } from "./stub-idp";

const base = "http://localhost:3000";
const kek = localKek(randomBytes(32).toString("base64"));
const mailer = memoryMailer();
const published = new Map<string, string[]>();
let licensed = true;
let t: TestDatabase;
let idp: StubIdp;
let auth: Auth;
let sso: EnterpriseSso;
let orgId: string;
let sealer: ReturnType<typeof createOrgSealer>;
const env = { ...process.env };
/** Puts a setting back as it was (assigning undefined would store the string "undefined"). */
const restore = (name: string) => {
  if (env[name] === undefined) delete process.env[name];
  else process.env[name] = env[name];
};

/** A browser: it keeps cookies the way one does, across the redirects of a sign-in. */
function browser() {
  let cookie = "";
  return {
    get headers() {
      return new Headers(cookie ? { cookie } : {});
    },
    async call(path: string, init: { method?: string; body?: unknown } = {}) {
      const res = await auth.handler(
        new Request(`${base}/api/auth${path}`, {
          method: init.method ?? "GET",
          headers: { "content-type": "application/json", origin: base, ...(cookie ? { cookie } : {}) },
          body: init.body ? JSON.stringify(init.body) : undefined,
          redirect: "manual",
        }),
      );
      const jar = new Map(
        cookie
          .split("; ")
          .filter(Boolean)
          .map((p) => {
            const i = p.indexOf("=");
            return [p.slice(0, i), p.slice(i + 1)] as [string, string];
          }),
      );
      for (const c of res.headers.getSetCookie()) {
        const pair = c.split(";", 1)[0] ?? "";
        const i = pair.indexOf("=");
        if (/max-age=0/i.test(c)) jar.delete(pair.slice(0, i));
        else jar.set(pair.slice(0, i), pair.slice(i + 1));
      }
      cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
      const text = await res.text();
      let json: Record<string, unknown> = {};
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        json = { raw: text };
      }
      return { status: res.status, json, location: res.headers.get("location") ?? "" };
    },
  };
}
type Browser = ReturnType<typeof browser>;

async function signInByLink(email: string): Promise<Browser> {
  const b = browser();
  await auth.api.signInMagicLink({ body: { email, callbackURL: "/" }, headers: new Headers() });
  const link = new URL(mailer.sent.filter((m) => m.to === email).at(-1)?.url ?? "");
  await b.call(`/magic-link/verify${link.search}`);
  return b;
}

/** The whole round trip through the stub for whoever it says is signing in. */
async function throughIdp(
  who: { sub: string; email: string; name: string },
  start: { providerId?: string; email?: string },
  b = browser(),
) {
  idp.as(who);
  const begin = await b.call("/sign-in/sso", { method: "POST", body: { ...start, callbackURL: "/" } });
  if (begin.status !== 200) return { begin, callback: null, b };
  const url = new URL(String(begin.json.url));
  expect(url.origin).toBe(idp.origin);
  const state = url.searchParams.get("state") ?? "";
  const providerId = start.providerId ?? "acme-okta";
  const callback = await b.call(`/sso/callback/${providerId}?code=c-${who.sub}&state=${encodeURIComponent(state)}`);
  return { begin, callback, b };
}

async function caller(b: Browser): Promise<SsoCaller> {
  const s = await auth.api.getSession({ headers: b.headers });
  if (!s) throw new Error("not signed in");
  const [m] = await t.owner<{ role: string }[]>`
    select role from auth.member where user_id = ${s.user.id} and organization_id = ${orgId}`;
  return { orgId, userId: s.user.id, sessionId: s.session.id, role: m?.role ?? "", headers: b.headers };
}

const userOf = async (email: string) =>
  (
    await t.owner<
      { id: string; email_verified: boolean }[]
    >`select id, email_verified from auth."user" where email = ${email}`
  )[0];
const roleOf = async (userId: string) =>
  (
    await t.owner<
      { role: string }[]
    >`select role from auth.member where user_id = ${userId} and organization_id = ${orgId}`
  )[0]?.role;
const actions = async () =>
  (
    await t.owner<{ action: string; detail: Record<string, unknown> }[]>`
    select action, detail from app.audit_log where org_id = ${orgId} order by id`
  ).map((r) => r);

let maya: Browser;

beforeAll(async () => {
  t = await freshDatabase();
  idp = await startStubIdp();
  // The stub is on loopback over http: listed by the operator, which outside production may name a local provider.
  // The SAML fixture's provider (idp.example.test) doesn't resolve here, so it's listed too.
  process.env.OPENDASH_SSO_TRUSTED_IDP_ORIGINS = `${idp.origin},https://idp.example.test`;
  sealer = createOrgSealer({ kek, run: (org, fn) => withTenantOn(t.app, { orgId: org }, fn) });
  const enterprise = singleSignOn({
    database: t.auth,
    sealer,
    origin: base,
    auth: () => auth,
    tenant: (ctx, fn) => withTenantOn(t.app, ctx, fn),
    system: (fn) => withSystemOn(t.system, fn),
    gate: () => ({ canChange: () => licensed }),
    // DNS as the domain's nameservers would answer it: whatever the test published.
    dns: async (_domain, name) => ({ authoritative: true, records: published.get(name) ?? [], doubled: [] }),
  });
  sso = enterprise.manage;
  auth = createAuth({
    secret: randomBytes(32).toString("base64"),
    database: t.auth,
    system: (fn) => withSystemOn(t.system, fn),
    kek,
    mailer,
    baseURL: base,
    inviteOnly: true,
    extension: enterprise.auth,
  });
  maya = await signInByLink("maya@acme.test");
  const org = await auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers: maya.headers });
  orgId = org?.id as string;
  maya = await signInByLink("maya@acme.test");
}, 60_000);

afterAll(async () => {
  restore("OPENDASH_SSO_TRUSTED_IDP_ORIGINS");
  await idp?.close();
  await t?.drop();
});

describe("single sign-on", () => {
  it("is set up as a draft, with its secret sealed and nothing fetched", async () => {
    const created = await sso.create(await caller(maya), {
      protocol: "oidc",
      name: "Okta",
      providerId: "acme-okta",
      domain: "Acme.test",
      issuer: idp.issuer,
      clientId: idp.clientId,
      clientSecret: STUB_CLIENT_SECRET,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value).toMatchObject({ status: "draft", domain: "acme.test", protocol: "oidc", name: "Okta" });
    expect(created.value.dns.name).toBe("_opendash-verification-acme-okta.acme.test");
    expect(created.value.endpoints.oidcRedirect).toBe(`${base}/api/auth/sso/callback/acme-okta`);
    expect(created.value.settings?.clientId).toBe(idp.clientId);
    expect(idp.hits).toEqual([]);
    const [row] = await t.owner<{ oidc_config: string }[]>`select oidc_config from auth.sso_provider`;
    expect(row?.oidc_config.startsWith("odk1.")).toBe(true);
    expect(row?.oidc_config).not.toContain(STUB_CLIENT_SECRET);
    expect(row?.oidc_config).not.toContain(idp.clientId);
  });

  it("refuses provider ids that don't fit the DNS label, and the plugin's own routes over HTTP", async () => {
    const tooLong = await sso.create(await caller(maya), {
      protocol: "oidc",
      name: "Long",
      providerId: "a".repeat(41),
      domain: "acme.test",
      issuer: idp.issuer,
      clientId: "x",
      clientSecret: "y",
    });
    expect(tooLong).toMatchObject({ ok: false, code: "INVALID" });
    for (const path of ["/sso/register", "/sso/verify-domain", "/sso/update-provider", "/sso/delete-provider"]) {
      expect((await maya.call(path, { method: "POST", body: {} })).status).toBe(404);
    }
  });

  it("can't sign anyone in while it's a draft", async () => {
    const begin = await browser().call("/sign-in/sso", {
      method: "POST",
      body: { email: "priya@acme.test", callbackURL: "/" },
    });
    expect(begin.status).toBe(403);
    expect(begin.json.code).toBe("SSO_UNAVAILABLE");
    expect((await sso.discover("priya@acme.test")).sso).toBe(false);
  });

  it("verifies the domain from its TXT record, and says what it found when it isn't there", async () => {
    const c = await caller(maya);
    const record = await sso.dnsRecord(c, "acme-okta");
    expect(record.ok).toBe(true);
    if (!record.ok) return;
    expect(record.value.value).toBeTruthy();
    const missing = await sso.verify(c, "acme-okta");
    expect(missing).toMatchObject({ ok: false, code: "DNS_NOT_FOUND" });
    published.set(record.value.name, [String(record.value.value)]);
    const verified = await sso.verify(c, "acme-okta");
    expect(verified).toMatchObject({ ok: true, value: { status: "verified", domainVerified: true } });
    const [claim] = await t.owner<
      { organization_id: string }[]
    >`select organization_id from auth.sso_domain where domain = 'acme.test'`;
    expect(claim?.organization_id).toBe(orgId);
    forgetProviderCaches();
    expect(await sso.discover("priya@acme.test")).toEqual({ sso: true, enforced: false });
  });

  it("lets someone new in through the callback, as a verified viewer, on an invite-only instance", async () => {
    const { callback, b } = await throughIdp(
      { sub: "priya", email: "priya@acme.test", name: "Priya Shah" },
      { email: "priya@acme.test" },
    );
    expect(callback?.status).toBe(302);
    expect(callback?.location).not.toMatch(/error/);
    const priya = await userOf("priya@acme.test");
    expect(priya?.email_verified).toBe(true);
    expect(await roleOf(priya?.id as string)).toBe("viewer");
    const s = await auth.api.getSession({ headers: b.headers });
    expect(s?.session).toMatchObject({
      authenticationMethod: "sso",
      ssoProviderId: "acme-okta",
      activeOrganizationId: orgId,
    });
    expect(s?.session.authenticatedAt).toBeTruthy();
    const rows = await actions();
    expect(rows.some((r) => r.action === "member.joined" && r.detail.role === "viewer")).toBe(true);
    expect(rows.some((r) => r.action === "signin.succeeded" && r.detail.method === "sso")).toBe(true);
  });

  it("covers exactly its domain: a subdomain or another domain is refused, and nobody is made", async () => {
    const byEmail = await browser().call("/sign-in/sso", {
      method: "POST",
      body: { email: "sam@eu.acme.test", callbackURL: "/" },
    });
    expect(byEmail.status).toBe(403);
    const { callback } = await throughIdp(
      { sub: "sam", email: "sam@eu.acme.test", name: "Sam" },
      { providerId: "acme-okta" },
    );
    expect(callback?.location).toMatch(/error=SSO_DOMAIN_MISMATCH/);
    expect(await userOf("sam@eu.acme.test")).toBeUndefined();
    const foreign = await throughIdp({ sub: "bob", email: "bob@lumen.test", name: "Bob" }, { providerId: "acme-okta" });
    expect(foreign.callback?.location).toMatch(/error=SSO_DOMAIN_MISMATCH/);
    expect(await userOf("bob@lumen.test")).toBeUndefined();
  });

  it("links someone who already has an account at the domain, keeping their role", async () => {
    const ines = uuidv7();
    await t.auth
      .client`insert into auth."user" (id, name, email, email_verified) values (${ines}, 'Ines', 'ines@acme.test', true)`;
    await t.auth
      .client`insert into auth.member (id, organization_id, user_id, role, created_at) values (${uuidv7()}, ${orgId}, ${ines}, 'member', now())`;
    const { callback } = await throughIdp(
      { sub: "ines", email: "ines@acme.test", name: "Ines" },
      { email: "ines@acme.test" },
    );
    expect(callback?.location).not.toMatch(/error/);
    const accounts = await t.owner<
      { provider_id: string }[]
    >`select provider_id from auth.account where user_id = ${ines}`;
    expect(accounts.map((a) => a.provider_id)).toContain("acme-okta");
    expect(await roleOf(ines)).toBe("member");
  });

  it("joins people new to the workspace with the provider's join role, never admin; an invitation's role wins", async () => {
    const c = await caller(maya);
    expect(await sso.setJoinRole(c, "acme-okta", "admin" as never)).toMatchObject({ ok: false, code: "INVALID" });
    licensed = false;
    expect(await sso.setJoinRole(c, "acme-okta", "member")).toMatchObject({ ok: false, code: "LICENSE_REQUIRED" });
    licensed = true;
    expect(await sso.setJoinRole(c, "acme-okta", "member")).toMatchObject({ ok: true, value: { joinRole: "member" } });
    const rows = await actions();
    expect(
      rows.some((r) => r.action === "sso.provider_updated" && r.detail.joinRole === "member" && r.detail.domain),
    ).toBe(true);
    // The database refuses admin whatever writes it.
    await expect(
      t.owner`update auth.sso_provider set join_role = 'admin' where provider_id = 'acme-okta'`,
    ).rejects.toThrow();

    const omar = await throughIdp({ sub: "omar", email: "omar@acme.test", name: "Omar" }, { email: "omar@acme.test" });
    expect(omar.callback?.location).not.toMatch(/error/);
    expect(await roleOf((await userOf("omar@acme.test"))?.id as string)).toBe("member");
    expect((await actions()).some((r) => r.action === "member.joined" && r.detail.role === "member")).toBe(true);

    // Someone already in the workspace keeps their role.
    await throughIdp({ sub: "priya", email: "priya@acme.test", name: "Priya Shah" }, { email: "priya@acme.test" });
    expect(await roleOf((await userOf("priya@acme.test"))?.id as string)).toBe("viewer");

    // Invited as a viewer: joins as one, and the invitation is accepted.
    const [owner] = await t.owner<{ id: string }[]>`select id from auth."user" where email = 'maya@acme.test'`;
    const invite = uuidv7();
    await t.auth.client`
      insert into auth.invitation (id, organization_id, email, role, status, expires_at, inviter_id)
      values (${invite}, ${orgId}, 'lena@acme.test', 'viewer', 'pending', now() + interval '1 day', ${owner?.id as string})`;
    const lena = await throughIdp({ sub: "lena", email: "lena@acme.test", name: "Lena" }, { email: "lena@acme.test" });
    expect(lena.callback?.location).not.toMatch(/error/);
    expect(await roleOf((await userOf("lena@acme.test"))?.id as string)).toBe("viewer");
    const [accepted] = await t.owner<{ status: string }[]>`select status from auth.invitation where id = ${invite}`;
    expect(accepted?.status).toBe("accepted");

    expect(await sso.setJoinRole(c, "acme-okta", "viewer")).toMatchObject({ ok: true, value: { joinRole: "viewer" } });
  });

  it("binds the invite-only exception to the callback, not the domain: no email link for someone new", async () => {
    const before = mailer.sent.length;
    await auth.api.signInMagicLink({ body: { email: "carol@acme.test", callbackURL: "/" }, headers: new Headers() });
    expect(mailer.sent.length).toBe(before);
    expect(await userOf("carol@acme.test")).toBeUndefined();
  });

  it("is activated only by a session that came through it after its last change", async () => {
    expect(await sso.activate(await caller(maya), "acme-okta")).toMatchObject({ ok: false, code: "TEST_REQUIRED" });
    const { b } = await throughIdp(
      { sub: "maya", email: "maya@acme.test", name: "Maya Chen" },
      { providerId: "acme-okta" },
    );
    maya = b;
    expect(await roleOf((await userOf("maya@acme.test"))?.id as string)).toBe("owner");
    const active = await sso.activate(await caller(maya), "acme-okta");
    expect(active).toMatchObject({ ok: true, value: { status: "active" } });
  });

  it("when required, ends other sessions and keys at the domain and refuses other ways in", async () => {
    const ines = (await userOf("ines@acme.test"))?.id as string;
    const inesByLink = await signInByLink("ines@acme.test");
    expect((await auth.api.getSession({ headers: inesByLink.headers }))?.user.email).toBe("ines@acme.test");
    await t.auth.client`insert into auth.apikey (id, config_id, reference_id, key, created_at, updated_at)
      values (${uuidv7()}, 'user', ${ines}, 'hashed', now(), now())`;
    const c = await caller(maya);
    expect(await sso.enforce(c, "acme-okta", "acme.tes")).toMatchObject({ ok: false, code: "CONFIRM" });
    const enforced = await sso.enforce(c, "acme-okta", "acme.test");
    expect(enforced.ok).toBe(true);
    if (!enforced.ok) return;
    expect(enforced.value.enforced).toBe(true);
    expect(enforced.value.sessionsEnded).toBeGreaterThanOrEqual(1);
    expect(enforced.value.keysRevoked).toBe(1);
    // The email-link session is gone; Maya's, from the provider, isn't.
    expect(await auth.api.getSession({ headers: inesByLink.headers })).toBeNull();
    expect((await auth.api.getSession({ headers: maya.headers }))?.user.email).toBe("maya@acme.test");
    // Layer 1: the other ways in.
    const password = await browser().call("/sign-in/email", {
      method: "POST",
      body: { email: "ines@acme.test", password: "whatever-it-is" },
    });
    expect(password).toMatchObject({ status: 403, json: { code: "SSO_REQUIRED" } });
    const link = await browser().call("/sign-in/magic-link", {
      method: "POST",
      body: { email: "ines@acme.test", callbackURL: "/" },
    });
    expect(link).toMatchObject({ status: 403, json: { code: "SSO_REQUIRED" } });
    expect(await sso.discover("ines@acme.test")).toEqual({ sso: true, enforced: true });
    const rows = await actions();
    expect(rows.some((r) => r.action === "sso.enforced" && r.detail.keysRevoked === 1)).toBe(true);
    expect(rows.some((r) => r.action === "signin.refused")).toBe(true);
  });

  it("refuses, and deletes, a session at an enforced domain that didn't come from the provider or is too old", async () => {
    const priya = { sub: "priya", email: "priya@acme.test", name: "Priya Shah" };
    const first = await throughIdp(priya, { email: "priya@acme.test" });
    const made = await auth.api.getSession({ headers: first.b.headers });
    expect(made?.user.email).toBe("priya@acme.test");
    // As if it had been made another way (another replica, before it saw enforcement).
    await t.auth.client`update auth.session set authentication_method = null, sso_provider_id = null
      where id = ${made?.session.id as string}`;
    expect(await auth.api.getSession({ headers: first.b.headers })).toBeNull();
    expect((await t.owner`select 1 from auth.session where id = ${made?.session.id as string}`).length).toBe(0);
    // The age bound: the provider vouched for Priya too long ago. Refused on any endpoint, not only the session read.
    process.env.OPENDASH_SSO_MAX_AUTH_AGE_HOURS = "1";
    resetSessionGuard();
    const second = await throughIdp(priya, { email: "priya@acme.test" });
    expect((await auth.api.getSession({ headers: second.b.headers }))?.user.email).toBe("priya@acme.test");
    await t.auth.client`update auth.session set authenticated_at = now() - interval '2 hours'
      where user_id = (select id from auth."user" where email = 'priya@acme.test')`;
    const list = await second.b.call("/organization/list");
    expect(list).toMatchObject({ status: 401, json: { code: "SSO_SESSION_REFUSED" } });
    expect(await auth.api.getSession({ headers: second.b.headers })).toBeNull();
    restore("OPENDASH_SSO_MAX_AUTH_AGE_HOURS");
    resetSessionGuard();
  });

  it("can't be removed or changed while required; Disable is the way back in, even without a license", async () => {
    const c = await caller(maya);
    expect(await sso.remove(c, "acme-okta")).toMatchObject({ ok: false, code: "ENFORCED" });
    expect(await sso.update(c, "acme-okta", { name: "Okta 2" })).toMatchObject({ ok: false, code: "ENFORCED" });
    licensed = false;
    expect(await sso.unenforce(c, "acme-okta")).toMatchObject({ ok: false, code: "LICENSE_REQUIRED" });
    const disabled = await sso.disable(c, "acme-okta");
    licensed = true;
    expect(disabled).toMatchObject({ ok: true, value: { status: "disabled", enforced: false } });
    if (disabled.ok) expect(disabled.value.sessionsEnded).toBeGreaterThanOrEqual(1);
    expect(await auth.api.getSession({ headers: maya.headers })).toBeNull();
    const begin = await browser().call("/sign-in/sso", {
      method: "POST",
      body: { email: "ines@acme.test", callbackURL: "/" },
    });
    expect(begin.status).toBe(403);
    // Email links work again for the domain.
    const link = await browser().call("/sign-in/magic-link", {
      method: "POST",
      body: { email: "ines@acme.test", callbackURL: "/" },
    });
    expect(link.status).toBe(200);
    maya = await signInByLink("maya@acme.test");
  });

  it("re-enables as verified (needing a new test sign-in), and is removed with its claim", async () => {
    const c = await caller(maya);
    expect(await sso.enable(c, "acme-okta")).toMatchObject({ ok: true, value: { status: "verified" } });
    const removed = await sso.remove(c, "acme-okta");
    expect(removed.ok).toBe(true);
    expect((await t.owner`select 1 from auth.sso_domain where domain = 'acme.test'`).length).toBe(0);
    const rows = (await actions()).map((r) => r.action);
    for (const a of [
      "sso.provider_added",
      "sso.domain_verified",
      "sso.activated",
      "sso.enforced",
      "sso.disabled",
      "sso.enabled",
      "sso.provider_removed",
    ]) {
      expect(rows).toContain(a);
    }
    // No secret or setting in any row.
    const raw = JSON.stringify(await t.owner`select * from app.audit_log where org_id = ${orgId}`);
    expect(raw).not.toContain(STUB_CLIENT_SECRET);
    expect(raw).not.toContain(idp.clientId);
  });

  it("doesn't trust an identity provider's origin as a redirect target off the SSO paths", async () => {
    const res = await browser().call("/sign-in/magic-link", {
      method: "POST",
      body: { email: "nobody@elsewhere.test", callbackURL: "https://graph.microsoft.com/phish" },
    });
    expect(res.status).toBe(403);
  });
});

describe("one organization per verified domain", () => {
  it("is held by the database whichever path verifies", async () => {
    const other = uuidv7();
    await t.auth
      .client`insert into auth.organization (id, name, slug, created_at) values (${other}, 'Lumen', 'lumen', now())`;
    await t.owner`insert into auth.sso_domain (domain, organization_id) values ('lumen.test', ${other})`;
    const id = uuidv7();
    await t.owner`insert into auth.sso_provider (id, issuer, provider_id, organization_id, domain)
      values (${id}, 'https://idp.lumen.test', 'acme-takes-lumen', ${orgId}, 'lumen.test')`;
    await expect(t.owner`update auth.sso_provider set domain_verified = true where id = ${id}`).rejects.toMatchObject({
      code: "23503",
    });
    await expect(t.owner`update auth.sso_provider set enforce_sso = true where id = ${id}`).rejects.toMatchObject({
      code: "23514",
    });
  });
});

describe("a SAML provider", () => {
  it("is registered from its metadata, sealed, and starts a sign-in at its SSO address", async () => {
    const created = await sso.create(await caller(maya), {
      protocol: "saml",
      name: "Okta SAML",
      providerId: "acme-saml",
      domain: "acme.test",
      metadataXml: samlMetadata("https://idp.example.test/saml", "https://idp.example.test/sso"),
    });
    expect(created).toMatchObject({
      ok: true,
      value: { protocol: "saml", status: "draft", issuer: "https://idp.example.test/saml" },
    });
    if (!created.ok) return;
    expect(created.value.endpoints.samlAcs).toBe(`${base}/api/auth/sso/saml2/sp/acs/acme-saml`);
    expect(created.value.settings?.entryPoint).toBe("https://idp.example.test/sso");
    const [row] = await t.owner<
      { saml_config: string }[]
    >`select saml_config from auth.sso_provider where provider_id = 'acme-saml'`;
    expect(row?.saml_config.startsWith("odk1.")).toBe(true);
    const record = await sso.dnsRecord(await caller(maya), "acme-saml");
    if (record.ok) published.set(record.value.name, [String(record.value.value)]);
    expect(await sso.verify(await caller(maya), "acme-saml")).toMatchObject({
      ok: true,
      value: { status: "verified" },
    });
    const begin = await browser().call("/sign-in/sso", {
      method: "POST",
      body: { providerId: "acme-saml", callbackURL: "/" },
    });
    expect(begin.status).toBe(200);
    const url = new URL(String(begin.json.url));
    expect(`${url.origin}${url.pathname}`).toBe("https://idp.example.test/sso");
    expect(url.searchParams.get("SAMLRequest")).toBeTruthy();
  });

  it("checks new metadata on an edit as it does on adding one", async () => {
    const c = await caller(maya);
    const plain = samlMetadata("https://idp.example.test/saml", "http://idp.example.test/sso");
    expect(await sso.update(c, "acme-saml", { metadataXml: plain })).toMatchObject({ ok: false, code: "INVALID" });
    const huge = samlMetadata().replace(
      "</md:EntityDescriptor>",
      `<!--${"x".repeat(100_001)}--></md:EntityDescriptor>`,
    );
    expect(await sso.update(c, "acme-saml", { metadataXml: huge })).toMatchObject({ ok: false, code: "INVALID" });
    expect(await sso.update(c, "acme-saml", { metadataUrl: "https://10.0.0.5/metadata" })).toMatchObject({
      ok: false,
      code: "METADATA_UNREADABLE",
    });
  });

  it("refuses metadata from a private address", async () => {
    const refused = await sso.create(await caller(maya), {
      protocol: "saml",
      name: "Internal",
      providerId: "acme-internal",
      domain: "acme.test",
      metadataUrl: "https://10.0.0.5/metadata",
    });
    expect(refused).toMatchObject({ ok: false, code: "METADATA_UNREADABLE" });
  });
});

describe("enforcement's cache", () => {
  it("serves session reads from it, but a sign-in reads the database (another replica may have just required it)", async () => {
    const id = uuidv7();
    await t.owner`insert into auth.sso_domain (domain, organization_id) values ('lumen-cache.test', ${orgId})`;
    await t.owner`insert into auth.sso_provider (id, issuer, provider_id, organization_id, domain, domain_verified, status)
      values (${id}, 'https://idp.lumen-cache.test', 'cache-check', ${orgId}, 'lumen-cache.test', true, 'active')`;
    forgetProviderCaches();
    expect(await enforcedProviderForDomain(t.auth.db, "lumen-cache.test")).toBeNull();
    // Required somewhere this process's cache doesn't hear about.
    await t.owner`update auth.sso_provider set enforce_sso = true where id = ${id}`;
    expect(await enforcedProviderForDomain(t.auth.db, "lumen-cache.test")).toBeNull();
    expect((await enforcedProviderForDomain(t.auth.db, "lumen-cache.test", { fresh: true }))?.providerId).toBe(
      "cache-check",
    );
    // And the fresh answer refreshed the cache for the session reads after it.
    expect((await enforcedProviderForDomain(t.auth.db, "lumen-cache.test"))?.providerId).toBe("cache-check");
    const res = await browser().call("/sign-in/email", {
      method: "POST",
      body: { email: "vera@lumen-cache.test", password: "whatever-it-is" },
    });
    expect(res).toMatchObject({ status: 403, json: { code: "SSO_REQUIRED" } });
  });
});

describe("changing a provider", () => {
  it("replaces the secret sealed, renames it, and takes it back to untested when its identity changes", async () => {
    const c = await caller(maya);
    const made = await sso.create(c, {
      protocol: "oidc",
      name: "Entra",
      providerId: "acme-entra",
      domain: "acme-two.test",
      issuer: idp.issuer,
      clientId: "entra-client",
      clientSecret: "first-secret-value",
    });
    expect(made.ok).toBe(true);
    const record = await sso.dnsRecord(c, "acme-entra");
    if (record.ok) published.set(record.value.name, [String(record.value.value)]);
    expect(await sso.verify(c, "acme-entra")).toMatchObject({ ok: true, value: { status: "verified" } });

    expect(await sso.rotateSecret(c, "acme-entra", "second-secret-value")).toEqual({ ok: true, value: null });
    const [row] = await t.owner<
      { oidc_config: string }[]
    >`select oidc_config from auth.sso_provider where provider_id = 'acme-entra'`;
    expect(row?.oidc_config.startsWith("odk1.")).toBe(true);
    expect(row?.oidc_config).not.toContain("second-secret-value");
    const opened = await ssoSecretCodec(sealer).open({
      organizationId: orgId,
      providerId: "acme-entra",
      oidcConfig: row?.oidc_config,
    });
    expect(JSON.parse(String(opened.oidcConfig))).toMatchObject({
      clientSecret: "second-secret-value",
      clientId: "entra-client",
    });

    expect(await sso.update(c, "acme-entra", { name: "Entra ID" })).toMatchObject({
      ok: true,
      value: { name: "Entra ID", status: "verified" },
    });
    // Active (as if a test sign-in passed), then a new client id: it needs a new test sign-in.
    await t.owner`update auth.sso_provider set status = 'active', last_tested_at = now() where provider_id = 'acme-entra'`;
    expect(await sso.update(c, "acme-entra", { clientId: "entra-client-2" })).toMatchObject({
      ok: true,
      value: { status: "verified", lastTestedAt: null, settings: { clientId: "entra-client-2" } },
    });
  });

  it("stops requiring it, and frees the domain it moves away from", async () => {
    const c = await caller(maya);
    await t.owner`update auth.sso_provider set status = 'active', last_tested_at = now() where provider_id = 'acme-entra'`;
    forgetProviderCaches();
    expect(await sso.enforce(c, "acme-entra", "acme-two.test")).toMatchObject({ ok: true, value: { enforced: true } });
    expect(await sso.unenforce(c, "acme-entra")).toMatchObject({ ok: true, value: { enforced: false } });
    expect(await sso.discover("lee@acme-two.test")).toEqual({ sso: true, enforced: false });
    const moved = await sso.update(c, "acme-entra", { domain: "acme-three.test" });
    expect(moved).toMatchObject({
      ok: true,
      value: { status: "draft", domainVerified: false, domain: "acme-three.test" },
    });
    expect((await t.owner`select 1 from auth.sso_domain where domain = 'acme-two.test'`).length).toBe(0);
    const rows = (await actions()).map((r) => r.action);
    for (const a of ["sso.secret_rotated", "sso.provider_updated", "sso.unenforced"]) expect(rows).toContain(a);
  });

  it("refuses provider ids other sign-ins use, and redirect targets that aren't this site's", async () => {
    for (const providerId of ["credential", "magic-link", "google"]) {
      const r = await sso.create(await caller(maya), {
        protocol: "oidc",
        name: "Taken",
        providerId,
        domain: "acme-four.test",
        issuer: idp.issuer,
        clientId: "x",
        clientSecret: "y",
      });
      expect(r).toMatchObject({ ok: false, code: "PROVIDER_ID_TAKEN" });
    }
    for (const key of ["callbackURL", "errorCallbackURL", "newUserCallbackURL"]) {
      const res = await browser().call("/sign-in/sso", {
        method: "POST",
        body: { providerId: "acme-entra", callbackURL: "/", [key]: "https://graph.microsoft.com/phish" },
      });
      expect(res).toMatchObject({ status: 403, json: { code: "INVALID_CALLBACK_URL" } });
    }
  });
});

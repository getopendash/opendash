// Single sign-on against a real identity provider: a local Keycloak (`pnpm --filter @opendash/ee keycloak:check` starts
// one in Docker, runs this file and stops it; skipped otherwise). A SAML round trip (a signed response to the request
// we made, its audience and recipient checked) and a second OIDC provider with real discovery and keys, each through
// Keycloak's own login form, as a browser would.
import { randomBytes } from "node:crypto";
import { type Auth, createAuth, memoryMailer } from "@opendash/auth";
import { createOrgSealer, localKek } from "@opendash/core";
import type { EnterpriseSso, SsoCaller } from "@opendash/core/enterprise";
import { freshDatabase, type TestDatabase, withSystemOn, withTenantOn } from "@opendash/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { singleSignOn } from "../src/sso";

const KEYCLOAK = process.env.OPENDASH_KEYCLOAK_URL;
const base = "http://localhost:3000";
const entityId = `${base}/api/auth`;
const kek = localKek(randomBytes(32).toString("base64"));
const mailer = memoryMailer();
const published = new Map<string, string[]>();
const env = { ...process.env };
let t: TestDatabase;
let auth: Auth;
let sso: EnterpriseSso;
let orgId: string;
let maya: Headers;

/** A browser: cookies per host, kept across redirects. */
function browser() {
  const jars = new Map<string, Map<string, string>>();
  const jarOf = (url: string) => {
    const host = new URL(url).host;
    if (!jars.has(host)) jars.set(host, new Map());
    return jars.get(host) as Map<string, string>;
  };
  return async (url: string, init: { method?: string; form?: Record<string, string>; json?: unknown } = {}) => {
    const jar = jarOf(url);
    const headers: Record<string, string> = {};
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    let body: string | undefined;
    if (init.form) {
      headers["content-type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(init.form).toString();
    } else if (init.json) {
      headers["content-type"] = "application/json";
      headers.origin = base;
      body = JSON.stringify(init.json);
    }
    const request = new Request(url, {
      method: init.method ?? (body ? "POST" : "GET"),
      headers,
      body,
      redirect: "manual",
    });
    // Our server is called in process; Keycloak over the network.
    const res = url.startsWith(base) ? await auth.handler(request) : await fetch(request);
    for (const c of res.headers.getSetCookie()) {
      const pair = c.split(";", 1)[0] ?? "";
      const i = pair.indexOf("=");
      if (/max-age=0|expires=thu, 01 jan 1970/i.test(c)) jar.delete(pair.slice(0, i));
      else jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    return { status: res.status, location: res.headers.get("location") ?? "", text: await res.text(), cookies: jar };
  };
}

const decode = (s: string) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x3d;/gi, "=")
    .replace(/&#61;/g, "=");

/** Keycloak's login form: fill it in and submit it, as someone would. */
async function logIn(go: ReturnType<typeof browser>, loginPage: string, username: string, password: string) {
  const page = await go(loginPage);
  const action = /<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/.exec(page.text)?.[1];
  if (!action) throw new Error(`no login form (status ${page.status})`);
  return go(decode(action), { form: { username, password, credentialId: "" } });
}

async function admin(path: string, init: { method?: string; json?: unknown } = {}, token?: string) {
  const res = await fetch(`${KEYCLOAK}${path}`, {
    method: init.method ?? (init.json ? "POST" : "GET"),
    headers: { authorization: `Bearer ${token}`, ...(init.json ? { "content-type": "application/json" } : {}) },
    body: init.json ? JSON.stringify(init.json) : undefined,
  });
  if (res.status >= 400) throw new Error(`Keycloak ${path} answered ${res.status}: ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function caller(): Promise<SsoCaller> {
  const s = await auth.api.getSession({ headers: maya });
  if (!s) throw new Error("not signed in");
  return { orgId, userId: s.user.id, sessionId: s.session.id, role: "owner", headers: maya };
}

async function verified(providerId: string) {
  const record = await sso.dnsRecord(await caller(), providerId);
  if (record.ok) published.set(record.value.name, [String(record.value.value)]);
  return sso.verify(await caller(), providerId);
}

describe.skipIf(!KEYCLOAK)("single sign-on with Keycloak", () => {
  let token = "";

  beforeAll(async () => {
    process.env.OPENDASH_SSO_TRUSTED_IDP_ORIGINS = new URL(KEYCLOAK as string).origin;
    const got = await fetch(`${KEYCLOAK}/realms/master/protocol/openid-connect/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "password",
        client_id: "admin-cli",
        username: "admin",
        password: "admin",
      }),
    });
    token = ((await got.json()) as { access_token: string }).access_token;
    await admin("/admin/realms", { json: { realm: "acme", enabled: true } }, token);
    await admin(
      "/admin/realms/acme/users",
      {
        json: {
          username: "lee",
          email: "lee@acme.test",
          emailVerified: true,
          enabled: true,
          firstName: "Lee",
          lastName: "Park",
          credentials: [{ type: "password", value: "Lee-pass-2026", temporary: false }],
        },
      },
      token,
    );

    t = await freshDatabase();
    const enterprise = singleSignOn({
      database: t.auth,
      sealer: createOrgSealer({ kek, run: (org, fn) => withTenantOn(t.app, { orgId: org }, fn) }),
      origin: base,
      auth: () => auth,
      tenant: (ctx, fn) => withTenantOn(t.app, ctx, fn),
      system: (fn) => withSystemOn(t.system, fn),
      gate: () => ({ canChange: () => true }),
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
    maya = await signIn();
    orgId = (await auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers: maya }))?.id as string;
    maya = await signIn();
  }, 120_000);

  afterAll(async () => {
    if (env.OPENDASH_SSO_TRUSTED_IDP_ORIGINS === undefined) delete process.env.OPENDASH_SSO_TRUSTED_IDP_ORIGINS;
    else process.env.OPENDASH_SSO_TRUSTED_IDP_ORIGINS = env.OPENDASH_SSO_TRUSTED_IDP_ORIGINS;
    await t?.drop();
  });

  it("signs someone new in over SAML 2.0: a signed response to our request, through Keycloak's login", async () => {
    const acs = `${base}/api/auth/sso/saml2/sp/acs/acme-keycloak-saml`;
    await admin(
      "/admin/realms/acme/clients",
      {
        json: {
          clientId: entityId,
          protocol: "saml",
          enabled: true,
          redirectUris: [acs],
          attributes: {
            saml_assertion_consumer_url_post: acs,
            "saml.client.signature": "false",
            "saml.server.signature": "true",
            "saml.assertion.signature": "true",
            "saml.signature.algorithm": "RSA_SHA256",
            saml_name_id_format: "email",
            "saml.force.name.id.format": "true",
          },
          protocolMappers: [
            {
              name: "email",
              protocol: "saml",
              protocolMapper: "saml-user-property-mapper",
              config: { "user.attribute": "email", "attribute.name": "email", "attribute.nameformat": "Basic" },
            },
          ],
        },
      },
      token,
    );
    const made = await sso.create(await caller(), {
      protocol: "saml",
      name: "Keycloak SAML",
      providerId: "acme-keycloak-saml",
      domain: "acme.test",
      metadataUrl: `${KEYCLOAK}/realms/acme/protocol/saml/descriptor`,
    });
    expect(made.ok ? made.value.protocol : `${made.code}: ${made.message}`).toBe("saml");
    expect(await verified("acme-keycloak-saml")).toMatchObject({ ok: true, value: { status: "verified" } });

    const go = browser();
    const start = await go(`${base}/api/auth/sign-in/sso`, {
      json: { providerId: "acme-keycloak-saml", callbackURL: "/" },
    });
    expect(start.status).toBe(200);
    const loginUrl = String(JSON.parse(start.text).url);
    expect(loginUrl.startsWith(`${KEYCLOAK}/realms/acme/protocol/saml`)).toBe(true);
    const posted = await logIn(go, loginUrl, "lee", "Lee-pass-2026");
    // Keycloak answers with a form that posts the signed response to our assertion consumer.
    const response = /name="SAMLResponse"\s+value="([^"]+)"/.exec(posted.text)?.[1];
    const relay = /name="RelayState"\s+value="([^"]*)"/.exec(posted.text)?.[1] ?? "";
    expect(response).toBeTruthy();
    const back = await go(acs, { form: { SAMLResponse: decode(response ?? ""), RelayState: decode(relay) } });
    expect(back.status).toBe(302);
    expect(back.location).not.toMatch(/error/);
    const [lee] = await t.owner<{ id: string; email_verified: boolean }[]>`
      select id, email_verified from auth."user" where email = 'lee@acme.test'`;
    expect(lee?.email_verified).toBe(true);
    const [session] = await t.owner<{ authentication_method: string; sso_provider_id: string }[]>`
      select authentication_method, sso_provider_id from auth.session where user_id = ${lee?.id as string}`;
    expect(session).toEqual({ authentication_method: "sso", sso_provider_id: "acme-keycloak-saml" });
    const [member] = await t.owner<{ role: string }[]>`
      select role from auth.member where user_id = ${lee?.id as string} and organization_id = ${orgId}`;
    expect(member?.role).toBe("viewer");
  });

  it("signs the same person in over OIDC, through Keycloak's discovery and keys, linking the same account", async () => {
    const redirect = `${base}/api/auth/sso/callback/acme-keycloak-oidc`;
    await admin(
      "/admin/realms/acme/clients",
      {
        json: {
          clientId: "opendash",
          protocol: "openid-connect",
          enabled: true,
          publicClient: false,
          secret: "keycloak-client-secret-for-tests",
          redirectUris: [redirect],
          standardFlowEnabled: true,
        },
      },
      token,
    );
    const made = await sso.create(await caller(), {
      protocol: "oidc",
      name: "Keycloak",
      providerId: "acme-keycloak-oidc",
      domain: "acme.test",
      issuer: `${KEYCLOAK}/realms/acme`,
      clientId: "opendash",
      clientSecret: "keycloak-client-secret-for-tests",
    });
    expect(made.ok).toBe(true);
    expect(await verified("acme-keycloak-oidc")).toMatchObject({ ok: true });

    const go = browser();
    const start = await go(`${base}/api/auth/sign-in/sso`, {
      json: { providerId: "acme-keycloak-oidc", callbackURL: "/" },
    });
    expect(start.status).toBe(200);
    const loggedIn = await logIn(go, String(JSON.parse(start.text).url), "lee", "Lee-pass-2026");
    expect(loggedIn.location.startsWith(redirect)).toBe(true);
    const back = await go(loggedIn.location);
    expect(back.status).toBe(302);
    expect(back.location).not.toMatch(/error/);
    const users = await t.owner`select id from auth."user" where email = 'lee@acme.test'`;
    expect(users.length).toBe(1);
    const providers = await t.owner<{ provider_id: string }[]>`
      select provider_id from auth.account where user_id = ${(users[0] as { id: string }).id} order by provider_id`;
    expect(providers.map((p) => p.provider_id)).toEqual(["acme-keycloak-oidc", "acme-keycloak-saml"]);
  });
});

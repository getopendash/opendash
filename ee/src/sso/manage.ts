/**
 * Single sign-on's providers and their lifecycle: draft → verified (DNS) → active (a
 * test sign-in) → enforced, and Disable as the way back in. The settings page calls these, never the plugin's own
 * routes (404 over HTTP): those know nothing of the lifecycle, the audit log or the license.
 *  - Owners and admins manage; anyone whose current session came through a provider since its last change may mark it
 *    active (whoever comes back from the identity provider may be someone it just added, as a viewer).
 *  - Changes need a license in production, except Disable: it's the way back in, and it only takes access away.
 *  - The plugin is called in process with the caller's cookie, for what it owns (the stored settings, the domain
 *    token); OpenDash's columns are written here, as opendash_auth.
 *  - Each change is audited right after it commits, as the acting member (the auth schema and the audit log are
 *    different roles' tables, so they can't share a transaction; a row that can't be written is logged). Rows carry
 *    field names and counts, never settings or secrets.
 */

import { audit, auditSystem, BUDGETS, type OrgSealer } from "@opendash/core";
import type { Enterprise, EnterpriseSso, SsoCaller, SsoProviderView, SsoResult } from "@opendash/core/enterprise";
import type { SystemTx, TenantTx } from "@opendash/db";
import type { AuthDatabase } from "@opendash/db/auth";
import { authTables as t } from "@opendash/db/auth";
import { and, desc, eq, ne, or, sql } from "drizzle-orm";
import { describeProbe, probeTxt, type TxtLookup, txtCarries } from "./dns";
import { assertPublicIdpUrl, fetchPublicText, IdpAddressRefused } from "./hosts";
import {
  emailDomain,
  maxSsoAuthAgeHours,
  normalizeDomain,
  OIDC_SCOPES,
  PROVIDER_ID_MAX,
  type SsoStatus,
  ssoDnsLabel,
} from "./policy";
import { ssoSecretCodec } from "./sealed-adapter";
import { forgetProviderCaches, signInProviderForDomain } from "./store";

type Row = typeof t.ssoProvider.$inferSelect;
type Db = AuthDatabase["db"];
type AuditEventOf = Parameters<typeof audit>[1];

export interface SsoManageDeps {
  database: AuthDatabase;
  sealer: OrgSealer;
  /** The auth server (its `api`), for the plugin's own endpoints. */
  auth: () => { api: unknown };
  /** A short transaction as the caller in their organization: the audit row's writer. */
  tenant: <T>(ctx: { orgId: string; userId: string }, fn: (tx: TenantTx) => Promise<T>) => Promise<T>;
  /** As the system role: rows in other workspaces whose members enforcement touched. */
  system: <T>(fn: (tx: SystemTx) => Promise<T>) => Promise<T>;
  gate: () => Pick<Enterprise, "canChange">;
  /** BETTER_AUTH_URL's origin: what the identity provider calls back. */
  origin: string;
  dns?: TxtLookup;
  /** Fetches a SAML provider's metadata (tests pass their own). */
  fetchMetadata?: (url: string, signal: AbortSignal) => Promise<string>;
}

const MANAGERS = new Set(["owner", "admin"]);
const isManager = (role: string) => role.split(",").some((r) => MANAGERS.has(r.trim()));

const fail = (
  code: string,
  message: string,
  detail?: string,
): { ok: false; code: string; message: string; detail?: string } =>
  detail ? { ok: false, code, message, detail } : { ok: false, code, message };
const ok = <T>(value: T): SsoResult<T> => ({ ok: true, value });

const PROVIDER_ID = new RegExp(`^[a-z0-9](?:[a-z0-9-]{0,${PROVIDER_ID_MAX - 2}}[a-z0-9])?$`);
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** The people at a domain, in any workspace on the instance: who enforcing it touches. */
const atDomain = (domain: string) =>
  sql`(select u.id from auth."user" u where lower(split_part(u.email, '@', 2)) = ${domain})`;

/** A key's maker, for org keys (keys.ts records it). */
const madeBy = sql`(case when ${t.apikey.metadata} is json object then (${t.apikey.metadata})::jsonb->>'madeBy' end)`;

/** The keys someone at the domain holds or made: their own keys, and the organization keys they made (keys.ts). */
const keysOfDomain = (domain: string) =>
  or(
    and(eq(t.apikey.configId, "user"), sql`${t.apikey.referenceId} in ${atDomain(domain)}`),
    and(eq(t.apikey.configId, "org"), sql`${madeBy}::uuid in ${atDomain(domain)}`),
  );

function extractSaml(xml: string): { entityId: string | null; ssoUrl: string | null } {
  const entityId = /<(?:\w+:)?EntityDescriptor\b[^>]*\bentityID="([^"]+)"/.exec(xml)?.[1] ?? null;
  const services = [...xml.matchAll(/<(?:\w+:)?SingleSignOnService\b([^>]*)\/?>/g)].map((m) => m[1] ?? "");
  const location = (attrs: string) => /\bLocation="([^"]+)"/.exec(attrs)?.[1] ?? null;
  const redirect = services.find((a) => a.includes("HTTP-Redirect")) ?? services.find((a) => a.includes("HTTP-POST"));
  return { entityId, ssoUrl: redirect ? location(redirect) : null };
}

const defaultFetchMetadata = (url: string, signal: AbortSignal) =>
  fetchPublicText(url, {
    signal,
    maxBytes: BUDGETS.sso.metadataBytes,
    accept: "application/samlmetadata+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
  });

/**
 * Provider ids Better Auth or its plugins use for other sign-in accounts. An SSO provider's id is the `provider_id`
 * of the accounts made through it (and Remove deletes those), so it must never be one of these, nor one an existing
 * account already uses.
 */
const RESERVED_PROVIDER_IDS = new Set([
  "credential",
  "email-otp",
  "magic-link",
  "phone-number",
  "anonymous",
  "siwe",
  "passkey",
  "two-factor",
  "sso",
  "api-key",
  "oauth",
  "apple",
  "atlassian",
  "cognito",
  "discord",
  "dropbox",
  "facebook",
  "figma",
  "github",
  "gitlab",
  "google",
  "huggingface",
  "kakao",
  "kick",
  "line",
  "linear",
  "linkedin",
  "microsoft",
  "naver",
  "notion",
  "paybin",
  "paypal",
  "polar",
  "reddit",
  "roblox",
  "salesforce",
  "slack",
  "spotify",
  "tiktok",
  "twitch",
  "twitter",
  "vercel",
  "vk",
  "zoom",
]);

export function ssoManager(deps: SsoManageDeps): EnterpriseSso {
  const { db } = deps.database;
  const codec = ssoSecretCodec(deps.sealer);
  const dns = deps.dns ?? probeTxt;
  const fetchMetadata = deps.fetchMetadata ?? defaultFetchMetadata;
  const endpointsFor = (providerId: string) => ({
    oidcRedirect: `${deps.origin}/api/auth/sso/callback/${encodeURIComponent(providerId)}`,
    samlAcs: `${deps.origin}/api/auth/sso/saml2/sp/acs/${encodeURIComponent(providerId)}`,
    samlMetadata: `${deps.origin}/api/auth/sso/saml2/sp/metadata?providerId=${encodeURIComponent(providerId)}`,
    entityId: `${deps.origin}/api/auth`,
  });

  /** The plugin's endpoints by name; a rename upstream fails here, legibly, rather than as "not a function". */
  const plugin = (name: "registerSSOProvider" | "updateSSOProvider" | "requestDomainVerification") => {
    const endpoint = (deps.auth().api as Record<string, unknown>)[name];
    if (typeof endpoint !== "function") throw new Error(`The SSO plugin has no ${name} endpoint`);
    return endpoint as (input: { body: unknown; headers: Headers }) => Promise<unknown>;
  };

  async function recordFor(caller: SsoCaller, event: AuditEventOf) {
    try {
      await deps.tenant({ orgId: caller.orgId, userId: caller.userId }, (tx) => audit(tx, event));
    } catch (error) {
      console.error(
        JSON.stringify({
          msg: "audit row not written",
          action: event.action,
          error: error instanceof Error ? error.message : "",
        }),
      );
    }
  }

  async function providerOf(orgId: string, providerId: string): Promise<Row | null> {
    const [row] = await db
      .select()
      .from(t.ssoProvider)
      .where(and(eq(t.ssoProvider.organizationId, orgId), eq(t.ssoProvider.providerId, providerId)));
    return row ?? null;
  }

  async function settingsOf(row: Row) {
    try {
      const open = await codec.open({ ...row });
      const oidc =
        typeof open.oidcConfig === "string" ? (JSON.parse(open.oidcConfig) as Record<string, unknown>) : null;
      const saml =
        typeof open.samlConfig === "string" ? (JSON.parse(open.samlConfig) as Record<string, unknown>) : null;
      const metadata = (saml?.idpMetadata as { metadata?: string } | undefined)?.metadata ?? "";
      return {
        clientId: typeof oidc?.clientId === "string" ? oidc.clientId : null,
        entryPoint: typeof saml?.entryPoint === "string" ? saml.entryPoint : null,
        idpEntityId: metadata ? extractSaml(metadata).entityId : null,
      };
    } catch (error) {
      // The page still shows the stage, addresses and record; editing is what a broken seal disables.
      console.error(
        JSON.stringify({ msg: "sso settings unreadable", providerId: row.providerId, error: String(error) }),
      );
      return null;
    }
  }

  async function view(row: Row, withSettings: boolean): Promise<SsoProviderView> {
    const [counts] = await db.execute<{ sessions: number; others: number; keys: number; linked: boolean }>(sql`
      select
        (select count(*)::int from auth.session where sso_provider_id = ${row.providerId} and expires_at > now()) as sessions,
        (select count(*)::int from auth.session s where s.user_id in ${atDomain(row.domain)}
           and s.expires_at > now() and s.sso_provider_id is distinct from ${row.providerId}) as others,
        (select count(*)::int from auth.apikey where ${keysOfDomain(row.domain)}) as keys,
        exists (select 1 from auth.account where provider_id = ${row.providerId}) as linked`);
    const protocol = row.samlConfig ? "saml" : "oidc";
    const settings = withSettings ? await settingsOf(row) : null;
    const label = ssoDnsLabel(row.providerId);
    return {
      providerId: row.providerId,
      name: row.name || row.providerId,
      protocol,
      issuer: protocol === "saml" ? (settings?.idpEntityId ?? "") : row.issuer,
      domain: row.domain,
      domainVerified: row.domainVerified,
      status: row.status as SsoStatus,
      enforced: row.enforceSso,
      lastTestedAt: row.lastTestedAt?.toISOString() ?? null,
      updatedAt: row.updatedAt.toISOString(),
      sessions: counts?.sessions ?? 0,
      otherSessions: counts?.others ?? 0,
      keysAtDomain: counts?.keys ?? 0,
      linked: Boolean(counts?.linked),
      endpoints: endpointsFor(row.providerId),
      dns: { name: `${label}.${row.domain}`, label },
      settings: settings ? { clientId: settings.clientId, entryPoint: settings.entryPoint } : null,
    };
  }

  /** The checks every change shares: a license (unless it's Disable), a manager, a provider of theirs. */
  async function changing(caller: SsoCaller, providerId: string, opts: { breakGlass?: boolean } = {}) {
    if (!opts.breakGlass && !deps.gate().canChange("sso")) {
      return fail("LICENSE_REQUIRED", "Changing single sign-on needs an Enterprise license.");
    }
    if (!isManager(caller.role)) return fail("FORBIDDEN", "Only owners and admins can change single sign-on.");
    const row = await providerOf(caller.orgId, providerId);
    return row ? ({ ok: true, row } as const) : fail("NOT_FOUND", "There's no such provider in this workspace.");
  }

  /** Who claimed a domain: this organization, another one, or nobody. */
  async function claimOf(domain: string): Promise<string | null> {
    const [claim] = await db
      .select({ orgId: t.ssoDomain.organizationId })
      .from(t.ssoDomain)
      .where(eq(t.ssoDomain.domain, domain));
    return claim?.orgId ?? null;
  }

  /** A domain no verified provider of its organization uses any more is free for another organization to prove. */
  const releaseClaim = (tx: Pick<Db, "execute">, domain: string, orgId: string) =>
    tx.execute(sql`
      delete from auth.sso_domain c where c.domain = ${domain} and c.organization_id = ${orgId}
        and not exists (select 1 from auth.sso_provider p where p.verified_domain = c.domain and p.organization_id = c.organization_id)`);

  async function activeToken(providerId: string) {
    const [row] = await db
      .select({ value: t.verification.value, expiresAt: t.verification.expiresAt })
      .from(t.verification)
      .where(eq(t.verification.identifier, ssoDnsLabel(providerId)))
      .orderBy(desc(t.verification.createdAt))
      .limit(1);
    return row && row.expiresAt.getTime() > Date.now() ? row : null;
  }

  /**
   * A SAML provider's metadata, from its URL (fetched once, pinned and capped) or pasted, with the checks both adding
   * and editing a provider need: within the size limit, an entity id, and a single sign-on address that's https on a
   * public address.
   */
  async function readMetadata(input: {
    metadataUrl?: string;
    metadataXml?: string;
  }): Promise<SsoResult<{ xml: string; entityId: string; ssoUrl: string }>> {
    let xml = input.metadataXml?.trim() ?? "";
    if (!xml && input.metadataUrl?.trim()) {
      try {
        await assertPublicIdpUrl(input.metadataUrl.trim());
        xml = await fetchMetadata(input.metadataUrl.trim(), AbortSignal.timeout(BUDGETS.sso.metadataMs));
      } catch (error) {
        const why = error instanceof Error ? error.message : "couldn't be read";
        return fail("METADATA_UNREADABLE", `The metadata address ${why}. You can paste the XML instead.`);
      }
    }
    if (!xml) return fail("INVALID", "Give your identity provider's metadata: its URL, or the XML.");
    if (xml.length > BUDGETS.sso.metadataBytes) return fail("INVALID", "That metadata is too large.");
    // OpenDash doesn't sign its sign-in requests yet. Some providers' metadata asks for signed ones as a preference
    // (Keycloak's always does) and the SAML library refuses to start a sign-in then, so the stored copy says it
    // doesn't; the provider's own setting for OpenDash decides. Signing protects the provider from forged requests,
    // not us: the response we accept is always signed and checked.
    xml = xml.replace(/(<(?:\w+:)?IDPSSODescriptor\b[^>]*\bWantAuthnRequestsSigned=)"(?:true|1)"/, '$1"false"');
    const { entityId, ssoUrl } = extractSaml(xml);
    if (!entityId || !ssoUrl) {
      return fail("INVALID", "That metadata has no identity provider entity id or single sign-on address.");
    }
    try {
      await assertPublicIdpUrl(ssoUrl);
    } catch (error) {
      return fail("INVALID", `Its single sign-on address ${error instanceof Error ? error.message : "isn't usable"}.`);
    }
    return ok({ xml, entityId, ssoUrl });
  }

  /** Workspaces other than the enforcing one whose members lost sessions or keys get a row saying so. */
  async function recordElsewhere(
    orgId: string,
    row: Row,
    sessions: { userId: string }[],
    keys: { configId: string; referenceId: string }[],
  ) {
    const users = [
      ...new Set([
        ...sessions.map((s) => s.userId),
        ...keys.filter((k) => k.configId === "user").map((k) => k.referenceId),
      ]),
    ];
    if (!users.length) return;
    try {
      const memberships = await db
        .select({ orgId: t.member.organizationId, userId: t.member.userId })
        .from(t.member)
        .where(sql`${t.member.userId} in ${users} and ${t.member.organizationId} <> ${orgId}`);
      const byOrg = new Map<string, { sessions: number; keys: number }>();
      for (const m of memberships) {
        const entry = byOrg.get(m.orgId) ?? { sessions: 0, keys: 0 };
        entry.sessions += sessions.filter((s) => s.userId === m.userId).length;
        entry.keys += keys.filter((k) => k.configId === "user" && k.referenceId === m.userId).length;
        byOrg.set(m.orgId, entry);
      }
      const actor = { type: "system" as const, name: `Single sign-on for ${row.domain}` };
      await deps.system(async (tx) => {
        for (const [other, n] of byOrg) {
          if (n.sessions)
            await auditSystem(tx, other, { action: "sessions.revoked", actor, detail: { count: n.sessions } });
          if (n.keys)
            await auditSystem(tx, other, {
              action: "api_key.revoked",
              actor,
              detail: { owner: "user", count: n.keys },
            });
        }
      });
    } catch (error) {
      console.error(JSON.stringify({ msg: "audit rows not written", action: "sso.enforced", error: String(error) }));
    }
  }

  const discoveries = new Map<string, { value: { sso: boolean; enforced: boolean }; expires: number }>();
  /** After a change: this process's caches read afresh (other replicas within their TTL). */
  const forget = (domain: string) => {
    forgetProviderCaches(domain);
    discoveries.delete(domain);
  };

  return {
    async list(caller) {
      const rows = isManager(caller.role)
        ? await db
            .select()
            .from(t.ssoProvider)
            .where(eq(t.ssoProvider.organizationId, caller.orgId))
            .orderBy(t.ssoProvider.createdAt)
        : [];
      return {
        providers: await Promise.all(rows.map((r) => view(r, true))),
        maxAuthAgeHours: maxSsoAuthAgeHours(),
        origin: deps.origin,
      };
    },

    async create(caller, input) {
      if (!deps.gate().canChange("sso"))
        return fail("LICENSE_REQUIRED", "Adding a provider needs an Enterprise license.");
      if (!isManager(caller.role)) return fail("FORBIDDEN", "Only owners and admins can add a provider.");
      const providerId = input.providerId.trim().toLowerCase();
      const domain = normalizeDomain(input.domain);
      const name = input.name.trim();
      if (!name || name.length > 60) return fail("INVALID", "Give the provider a name of up to 60 characters.");
      if (!PROVIDER_ID.test(providerId)) {
        return fail(
          "INVALID",
          `The provider id is lowercase letters, digits and dashes, at most ${PROVIDER_ID_MAX} characters: it's in the DNS record's name and the addresses your identity provider calls.`,
        );
      }
      if (!DOMAIN.test(domain)) return fail("INVALID", "The domain is a bare email domain, like acme.com.");
      const claim = await claimOf(domain);
      if (claim && claim !== caller.orgId) {
        return fail("DOMAIN_CLAIMED", "Another workspace on this instance has already proved this domain.");
      }
      const [taken] = await db
        .select({ id: t.ssoProvider.id })
        .from(t.ssoProvider)
        .where(eq(t.ssoProvider.providerId, providerId));
      const [account] = await db
        .select({ id: t.account.id })
        .from(t.account)
        .where(eq(t.account.providerId, providerId))
        .limit(1);
      if (taken || account || RESERVED_PROVIDER_IDS.has(providerId)) {
        return fail("PROVIDER_ID_TAKEN", "That provider id is in use on this instance. Pick another.");
      }

      let body: Record<string, unknown>;
      if (input.protocol === "oidc") {
        const issuer = input.issuer.trim().replace(/\/$/, "");
        const discoveryUrl = input.discoveryUrl?.trim() || `${issuer}/.well-known/openid-configuration`;
        try {
          await assertPublicIdpUrl(issuer);
          if (new URL(discoveryUrl).origin !== new URL(issuer).origin) {
            return fail("INVALID", "The discovery address must be on the issuer's address.");
          }
        } catch (error) {
          if (error instanceof IdpAddressRefused) return fail("INVALID", `The issuer URL ${error.message}.`);
          return fail("INVALID", "The issuer and discovery addresses must be URLs.");
        }
        const clientId = input.clientId.trim();
        if (!clientId || clientId.length > 512)
          return fail("INVALID", "Paste the client ID from your identity provider.");
        if (!input.clientSecret || input.clientSecret.length > 4096) {
          return fail("INVALID", "Paste the client secret from your identity provider.");
        }
        // Discovery is skipped now and runs at the first sign-in, from an origin trusted only once the domain is
        // proved: nothing leaves the server for an identity provider nobody has proved a domain for.
        body = {
          providerId,
          issuer,
          domain,
          organizationId: caller.orgId,
          oidcConfig: {
            clientId,
            clientSecret: input.clientSecret,
            discoveryEndpoint: discoveryUrl,
            skipDiscovery: true,
            pkce: true,
            scopes: OIDC_SCOPES,
          },
        };
      } else {
        const metadata = await readMetadata(input);
        if (!metadata.ok) return metadata;
        const { xml, ssoUrl } = metadata.value;
        const ours = endpointsFor(providerId);
        // The SP is OpenDash: its entity id is the auth base URL; signed assertions required, the IdP's signing
        // certificate read from its metadata.
        body = {
          providerId,
          issuer: ours.entityId,
          domain,
          organizationId: caller.orgId,
          samlConfig: {
            entryPoint: ssoUrl,
            audience: ours.entityId,
            idpMetadata: { metadata: xml },
            spMetadata: { entityID: ours.entityId },
            wantAssertionsSigned: true,
          },
        };
      }
      try {
        await plugin("registerSSOProvider")({ body, headers: caller.headers });
      } catch (error) {
        console.error(
          JSON.stringify({
            msg: "sso register refused",
            providerId,
            error: error instanceof Error ? error.message : "",
          }),
        );
        return fail("REFUSED", "The identity provider's settings were refused. Check them and try again.");
      }
      const [row] = await db
        .update(t.ssoProvider)
        .set({ name, status: "draft", updatedAt: new Date() })
        .where(eq(t.ssoProvider.providerId, providerId))
        .returning();
      if (!row) return fail("REFUSED", "The provider wasn't saved.");
      await recordFor(caller, {
        action: "sso.provider_added",
        target: { type: "sso_provider", name },
        fields: input.protocol === "oidc" ? ["issuer", "clientId", "clientSecret"] : ["metadata"],
        detail: { protocol: input.protocol, domain },
      });
      return ok(await view(row, true));
    },

    async dnsRecord(caller, providerId) {
      const checked = await changing(caller, providerId);
      if (!checked.ok) return checked;
      const { row } = checked;
      const label = ssoDnsLabel(row.providerId);
      const name = `${label}.${row.domain}`;
      if (row.domainVerified) return ok({ name, label, value: null, expiresAt: null });
      let token = await activeToken(row.providerId);
      if (!token) {
        try {
          await plugin("requestDomainVerification")({ body: { providerId: row.providerId }, headers: caller.headers });
        } catch (error) {
          console.error(JSON.stringify({ msg: "sso token not issued", providerId, error: String(error) }));
          return fail("TOKEN_FAILED", "A verification value couldn't be made. Try again.");
        }
        token = await activeToken(row.providerId);
      }
      return ok({ name, label, value: token?.value ?? null, expiresAt: token?.expiresAt.toISOString() ?? null });
    },

    async verify(caller, providerId) {
      const checked = await changing(caller, providerId);
      if (!checked.ok) return checked;
      const { row } = checked;
      if (row.status === "disabled") return fail("DISABLED", "Enable the provider first.");
      if (row.domainVerified) return ok(await view(row, true));
      const claim = await claimOf(row.domain);
      if (claim && claim !== caller.orgId) {
        return fail("DOMAIN_CLAIMED", "Another workspace on this instance has already proved this domain.");
      }
      const token = await activeToken(row.providerId);
      if (!token) return fail("TOKEN_EXPIRED", "The verification value lapsed. Show the record again for a new one.");
      const label = ssoDnsLabel(row.providerId);
      const name = `${label}.${row.domain}`;
      const probe = await dns(row.domain, name, AbortSignal.timeout(BUDGETS.sso.dnsCheckMs));
      if (!txtCarries(probe.records, label, token.value)) {
        return fail(
          "DNS_NOT_FOUND",
          "The record isn't there yet.",
          describeProbe(probe, row.domain, name, token.value),
        );
      }
      let verified: Row | undefined;
      try {
        verified = await db.transaction(async (tx) => {
          // The claim, then the flag: the foreign key refuses the flag if another organization holds the claim.
          await tx
            .insert(t.ssoDomain)
            .values({ domain: row.domain, organizationId: caller.orgId })
            .onConflictDoNothing();
          const [next] = await tx
            .update(t.ssoProvider)
            .set({
              domainVerified: true,
              status: sql`case when ${t.ssoProvider.status} = 'active' then 'active' else 'verified' end`,
              updatedAt: new Date(),
            })
            .where(eq(t.ssoProvider.id, row.id))
            .returning();
          await tx.delete(t.verification).where(eq(t.verification.identifier, label));
          return next;
        });
      } catch (error) {
        if ((error as { cause?: { code?: string } }).cause?.code === "23503") {
          return fail("DOMAIN_CLAIMED", "Another workspace on this instance has already proved this domain.");
        }
        throw error;
      }
      if (!verified) return fail("NOT_FOUND", "The provider wasn't updated.");
      forget(row.domain);
      await recordFor(caller, {
        action: "sso.domain_verified",
        target: { type: "sso_provider", name: row.name },
        detail: { domain: row.domain },
      });
      return ok(await view(verified, true));
    },

    async activate(caller, providerId) {
      if (!deps.gate().canChange("sso"))
        return fail("LICENSE_REQUIRED", "Activating a provider needs an Enterprise license.");
      const row = await providerOf(caller.orgId, providerId);
      if (!row) return fail("NOT_FOUND", "There's no such provider in this workspace.");
      if (!row.domainVerified) return fail("NOT_VERIFIED", "Verify the domain first.");
      if (row.status === "disabled") return fail("DISABLED", "Enable the provider first.");
      // The proof: this very session came through the provider, after its settings were last changed. A session
      // from before a change proved the old settings.
      const [mine] = await db
        .select({ provider: t.session.ssoProviderId, at: t.session.authenticatedAt })
        .from(t.session)
        .where(eq(t.session.id, caller.sessionId));
      if (mine?.provider !== row.providerId) {
        return fail("TEST_REQUIRED", "Sign in through this provider first, then activate it.");
      }
      if (!mine.at || mine.at <= row.updatedAt) {
        return fail("TEST_STALE", "Its settings changed after that sign-in. Sign in through it again.");
      }
      const now = new Date();
      const [active] = await db
        .update(t.ssoProvider)
        .set({ status: "active", lastTestedAt: now, updatedAt: now })
        .where(and(eq(t.ssoProvider.id, row.id), ne(t.ssoProvider.status, "disabled")))
        .returning();
      if (!active) return fail("NOT_FOUND", "The provider wasn't updated.");
      forget(row.domain);
      await recordFor(caller, {
        action: "sso.activated",
        target: { type: "sso_provider", name: row.name },
        detail: { domain: row.domain },
      });
      return ok(await view(active, isManager(caller.role)));
    },

    async enforce(caller, providerId, confirmDomain) {
      const checked = await changing(caller, providerId);
      if (!checked.ok) return checked;
      const { row } = checked;
      if (normalizeDomain(confirmDomain) !== row.domain) return fail("CONFIRM", `Type ${row.domain} to confirm.`);
      if (!(row.domainVerified && row.status === "active")) {
        return fail("NOT_ACTIVE", "A provider can be required once its domain is verified and a test sign-in passed.");
      }
      // Everyone at the domain, in every workspace: a verified domain is one organization's, and requiring it is a
      // statement about the people at it. Their other sessions end and their keys are revoked (a key never signs in
      // again), in the same transaction as the switch.
      const result = await db.transaction(async (tx) => {
        const [enforced] = await tx
          .update(t.ssoProvider)
          .set({ enforceSso: true, updatedAt: new Date() })
          .where(eq(t.ssoProvider.id, row.id))
          .returning();
        if (!enforced) throw new Error("The provider wasn't updated");
        const sessions = await tx
          .delete(t.session)
          .where(
            and(
              sql`${t.session.userId} in ${atDomain(row.domain)}`,
              sql`${t.session.ssoProviderId} is distinct from ${row.providerId}`,
            ),
          )
          .returning({ userId: t.session.userId });
        const keys = await tx
          .delete(t.apikey)
          .where(keysOfDomain(row.domain))
          .returning({ configId: t.apikey.configId, referenceId: t.apikey.referenceId });
        return { enforced, sessions, keys };
      });
      forget(row.domain);
      await recordFor(caller, {
        action: "sso.enforced",
        target: { type: "sso_provider", name: row.name },
        fields: ["enforce"],
        detail: { domain: row.domain, sessionsEnded: result.sessions.length, keysRevoked: result.keys.length },
      });
      await recordElsewhere(caller.orgId, row, result.sessions, result.keys);
      return ok({
        ...(await view(result.enforced, true)),
        sessionsEnded: result.sessions.length,
        keysRevoked: result.keys.length,
      });
    },

    async unenforce(caller, providerId) {
      const checked = await changing(caller, providerId);
      if (!checked.ok) return checked;
      const { row } = checked;
      const [next] = await db
        .update(t.ssoProvider)
        .set({ enforceSso: false, updatedAt: new Date() })
        .where(eq(t.ssoProvider.id, row.id))
        .returning();
      if (!next) return fail("NOT_FOUND", "The provider wasn't updated.");
      forget(row.domain);
      if (row.enforceSso) {
        await recordFor(caller, {
          action: "sso.unenforced",
          target: { type: "sso_provider", name: row.name },
          fields: ["enforce"],
          detail: { domain: row.domain },
        });
      }
      return ok(await view(next, true));
    },

    async disable(caller, providerId) {
      const checked = await changing(caller, providerId, { breakGlass: true });
      if (!checked.ok) return checked;
      const { row } = checked;
      const result = await disableProvider(db, row);
      forget(row.domain);
      await recordFor(caller, {
        action: "sso.disabled",
        target: { type: "sso_provider", name: row.name },
        detail: { domain: row.domain, sessionsEnded: result.sessionsEnded },
      });
      return ok({ ...(await view(result.row, true)), sessionsEnded: result.sessionsEnded });
    },

    async enable(caller, providerId) {
      const checked = await changing(caller, providerId);
      if (!checked.ok) return checked;
      const { row } = checked;
      if (row.status !== "disabled") return ok(await view(row, true));
      // The domain proof is kept; a new test sign-in makes it active again.
      const [next] = await db
        .update(t.ssoProvider)
        .set({ status: row.domainVerified ? "verified" : "draft", updatedAt: new Date() })
        .where(eq(t.ssoProvider.id, row.id))
        .returning();
      if (!next) return fail("NOT_FOUND", "The provider wasn't updated.");
      forget(row.domain);
      await recordFor(caller, {
        action: "sso.enabled",
        target: { type: "sso_provider", name: row.name },
        detail: { domain: row.domain },
      });
      return ok(await view(next, true));
    },

    async update(caller, providerId, change) {
      const checked = await changing(caller, providerId);
      if (!checked.ok) return checked;
      const { row } = checked;
      if (row.enforceSso) return fail("ENFORCED", "Stop requiring it before changing its settings.");
      const protocol = row.samlConfig ? "saml" : "oidc";
      const name = change.name?.trim();
      const domain = change.domain ? normalizeDomain(change.domain) : undefined;
      const domainChanged = domain !== undefined && domain !== row.domain;
      if (name !== undefined && (!name || name.length > 60))
        return fail("INVALID", "Give the provider a name of up to 60 characters.");
      if (domainChanged && !DOMAIN.test(domain))
        return fail("INVALID", "The domain is a bare email domain, like acme.com.");
      if (domainChanged) {
        const claim = await claimOf(domain);
        if (claim && claim !== caller.orgId) {
          return fail("DOMAIN_CLAIMED", "Another workspace on this instance has already proved this domain.");
        }
      }
      const identity =
        protocol === "oidc"
          ? { issuer: change.issuer, clientId: change.clientId, discoveryEndpoint: change.discoveryUrl }
          : { metadata: change.metadataXml ?? change.metadataUrl };
      if (protocol === "saml" && (change.issuer || change.clientId || change.discoveryUrl)) {
        return fail("INVALID", "That setting is for OIDC providers.");
      }
      if (protocol === "oidc" && (change.metadataUrl || change.metadataXml)) {
        return fail("INVALID", "That setting is for SAML providers.");
      }
      const identityChanged = Object.values(identity).some((v) => v !== undefined && v !== "");
      const [linked] = await db
        .select({ id: t.account.id })
        .from(t.account)
        .where(eq(t.account.providerId, row.providerId))
        .limit(1);
      if (identityChanged && linked) {
        return fail(
          "IDENTITY_LOCKED",
          "Someone has signed in through this provider, so its issuer, client and metadata can't change. Add a new provider instead.",
        );
      }
      const pluginBody: Record<string, unknown> = { providerId: row.providerId };
      if (domainChanged) pluginBody.domain = domain;
      if (protocol === "oidc" && identityChanged) {
        const issuer = change.issuer?.trim().replace(/\/$/, "");
        try {
          if (issuer) await assertPublicIdpUrl(issuer);
          const base = issuer ?? row.issuer;
          if (change.discoveryUrl && new URL(change.discoveryUrl).origin !== new URL(base).origin) {
            return fail("INVALID", "The discovery address must be on the issuer's address.");
          }
        } catch (error) {
          return fail(
            "INVALID",
            `The issuer URL ${error instanceof IdpAddressRefused ? error.message : "isn't a URL"}.`,
          );
        }
        if (issuer) pluginBody.issuer = issuer;
        pluginBody.oidcConfig = {
          ...(change.clientId ? { clientId: change.clientId.trim() } : {}),
          ...(change.discoveryUrl || issuer
            ? {
                discoveryEndpoint:
                  change.discoveryUrl?.trim() || `${issuer ?? row.issuer}/.well-known/openid-configuration`,
              }
            : {}),
          skipDiscovery: true,
          scopes: OIDC_SCOPES,
        };
      }
      if (protocol === "saml" && identityChanged) {
        const metadata = await readMetadata(change);
        if (!metadata.ok) return metadata;
        const { xml, ssoUrl } = metadata.value;
        pluginBody.samlConfig = { entryPoint: ssoUrl, idpMetadata: { metadata: xml } };
      }
      // A new domain needs proving again; new identity settings need a new test sign-in. Our demotion goes first, in
      // the same transaction as the plugin's write, so a refused write leaves nothing changed on either side.
      const status = domainChanged ? "draft" : identityChanged && row.status === "active" ? "verified" : row.status;
      const fields = [
        ...(name !== undefined && name !== row.name ? ["name"] : []),
        ...(domainChanged ? ["domain"] : []),
        ...Object.entries(identity)
          .filter(([, v]) => v !== undefined && v !== "")
          .map(([k]) => k),
      ];
      if (!fields.length) return ok(await view(row, true));
      try {
        await db.transaction(async (tx) => {
          await tx
            .update(t.ssoProvider)
            .set({
              ...(name !== undefined ? { name } : {}),
              status,
              ...(domainChanged ? { domainVerified: false } : {}),
              ...(domainChanged || identityChanged ? { lastTestedAt: null } : {}),
              updatedAt: new Date(),
            })
            .where(eq(t.ssoProvider.id, row.id));
          if (domainChanged) await releaseClaim(tx, row.domain, caller.orgId);
        });
        if (Object.keys(pluginBody).length > 1) {
          await plugin("updateSSOProvider")({ body: pluginBody, headers: caller.headers });
        }
      } catch (error) {
        console.error(JSON.stringify({ msg: "sso update refused", providerId, error: String(error) }));
        return fail("REFUSED", "The change was refused. Check the settings and try again.");
      }
      forget(row.domain);
      const next = await providerOf(caller.orgId, row.providerId);
      if (!next) return fail("NOT_FOUND", "The provider wasn't found.");
      await recordFor(caller, {
        action: "sso.provider_updated",
        target: { type: "sso_provider", name: next.name },
        fields,
        detail: { protocol, domain: next.domain },
      });
      return ok(await view(next, true));
    },

    async rotateSecret(caller, providerId, clientSecret) {
      const checked = await changing(caller, providerId);
      if (!checked.ok) return checked;
      const { row } = checked;
      if (row.samlConfig)
        return fail("INVALID", "A SAML provider has no client secret: its certificate comes from its metadata.");
      if (!clientSecret || clientSecret.length > 4096) return fail("INVALID", "Paste the new client secret.");
      try {
        await plugin("updateSSOProvider")({
          body: { providerId: row.providerId, oidcConfig: { clientSecret } },
          headers: caller.headers,
        });
      } catch (error) {
        console.error(JSON.stringify({ msg: "sso secret refused", providerId, error: String(error) }));
        return fail("REFUSED", "The new secret was refused.");
      }
      await db.update(t.ssoProvider).set({ updatedAt: new Date() }).where(eq(t.ssoProvider.id, row.id));
      await recordFor(caller, {
        action: "sso.secret_rotated",
        target: { type: "sso_provider", name: row.name },
        fields: ["clientSecret"],
        detail: { protocol: "oidc" },
      });
      return ok(null);
    },

    async remove(caller, providerId) {
      const checked = await changing(caller, providerId);
      if (!checked.ok) return checked;
      const { row } = checked;
      if (row.enforceSso) return fail("ENFORCED", "Stop requiring it before removing it.");
      // Its sessions go with it (the foreign key cascades), and so does what links people to it: the accounts with its
      // id, which is never another sign-in's (RESERVED_PROVIDER_IDS and the check at create).
      const sessionsEnded = await db.transaction(async (tx) => {
        const [{ n } = { n: 0 }] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(t.session)
          .where(eq(t.session.ssoProviderId, row.providerId));
        await tx.delete(t.account).where(eq(t.account.providerId, row.providerId));
        await tx.delete(t.ssoProvider).where(eq(t.ssoProvider.id, row.id));
        await tx.delete(t.verification).where(eq(t.verification.identifier, ssoDnsLabel(row.providerId)));
        await releaseClaim(tx, row.domain, caller.orgId);
        return n;
      });
      forget(row.domain);
      await recordFor(caller, {
        action: "sso.provider_removed",
        target: { type: "sso_provider", name: row.name },
        detail: { domain: row.domain, sessionsEnded },
      });
      return ok({ sessionsEnded });
    },

    async discover(email) {
      const none = { sso: false, enforced: false };
      const domain = emailDomain(email);
      if (!domain || !DOMAIN.test(domain)) return none;
      const now = Date.now();
      const hit = discoveries.get(domain);
      if (hit && hit.expires > now) return hit.value;
      const provider = await signInProviderForDomain(db, domain);
      const value = { sso: Boolean(provider), enforced: Boolean(provider?.enforceSso) };
      // Bounded: someone trying many domains mustn't grow it without limit.
      if (discoveries.size >= 10_000) discoveries.clear();
      discoveries.set(domain, { value, expires: now + 60_000 });
      return value;
    },
  };
}

/**
 * Disable, the way back in, shared with the operator's `pnpm sso:disable`: nobody signs in through it, its sessions
 * end, and requiring it lifts. Its settings and the domain proof stay, so Enable needs neither again.
 */
export async function disableProvider(db: Db, row: Row): Promise<{ row: Row; sessionsEnded: number }> {
  const result = await db.transaction(async (tx) => {
    const [next] = await tx
      .update(t.ssoProvider)
      .set({ status: "disabled", enforceSso: false, updatedAt: new Date() })
      .where(eq(t.ssoProvider.id, row.id))
      .returning();
    const gone = await tx
      .delete(t.session)
      .where(eq(t.session.ssoProviderId, row.providerId))
      .returning({ id: t.session.id });
    return { row: next ?? row, sessionsEnded: gone.length };
  });
  forgetProviderCaches(row.domain);
  return result;
}

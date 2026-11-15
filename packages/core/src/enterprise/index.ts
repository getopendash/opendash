/**
 * What the core knows of the enterprise features: their names, what a license says, and whether a feature may be set
 * up. Their code is in ee/, which the core never imports: each app's enterprise.ts hands it in. Pure (types and
 * constants), so client code may import it.
 */
import type { SystemTx, TenantTx } from "@opendash/db";

export const ENTERPRISE_FEATURES = ["sso", "scim", "audit"] as const;
export type EnterpriseFeature = (typeof ENTERPRISE_FEATURES)[number];

export const ENTERPRISE_FEATURE_LABELS: Record<EnterpriseFeature, string> = {
  sso: "Single sign-on",
  scim: "Directory sync",
  audit: "Audit chain, retention and exports",
};

/** What a verified license key says. */
export interface License {
  licensee: string;
  features: EnterpriseFeature[];
  seats: number | null;
  /** ISO 8601. */
  expiresAt: string;
  /** The instance it's for (an origin), or null for any. */
  instance: string | null;
}

export type LicenseStatus =
  /** A build without ee/. */
  | { state: "community" }
  | { state: "none" }
  | { state: "invalid"; reason: string }
  | { state: "expired"; license: License }
  | { state: "valid"; license: License; expiresSoon: boolean }
  /**
   * The licensor's own service (OpenDash Cloud): a key signed for it, with no expiry, address or seats, covering every
   * feature. Its people never see licensing: there's nothing for them to act on.
   */
  | { state: "service"; licensee: string };

export interface Enterprise {
  /** NODE_ENV is production: enterprise features then need a license to be set up. */
  production: boolean;
  /** What the license key says now. Its signature is checked once, at start-up; its expiry each time. */
  status(): LicenseStatus;
  /**
   * Whether a feature may be set up or changed: always outside production, as the license of ee/ allows for
   * development and testing, and in production only with a valid key that covers it, or a service key. Nothing asks
   * whether a feature may run: what's set up keeps running, so a lapsed key never weakens security.
   */
  canChange(feature: EnterpriseFeature): boolean;
  /** The audit log's hash chain, retention and exports, when this build has them. */
  audit?: EnterpriseAudit;
  /** Single sign-on's providers and their lifecycle, when this build has them. */
  sso?: EnterpriseSso;
  /** Directory sync over SCIM 2.0, when this build has it. */
  scim?: EnterpriseScim;
}

export type ScimRole = "admin" | "member" | "viewer";

/** A group the directory pushed, and the role it gives here. */
export interface ScimGroupView {
  groupId: string;
  name: string;
  members: number;
  /** Null: no role of its own (people only in it are viewers). */
  role: ScimRole | null;
}

/** What the directory sync page shows. */
export interface ScimStatus {
  /** The address the directory calls. */
  baseUrl: string;
  /** A directory connected, with a token that works. */
  connected: boolean;
  token: { createdAt: string; expiresAt: string; lastUsedAt: string | null } | null;
  /** The workspace's verified single sign-on domains: only people there are added. */
  domains: string[];
  groups: ScimGroupView[];
  /** People the directory has added and keeps active. */
  people: number;
  /** Its latest changes, newest first, from the audit log. */
  recent: { at: string; action: string; target: string | null; detail: Record<string, unknown> }[];
}

export interface EnterpriseScim {
  status(caller: SsoCaller): Promise<ScimStatus>;
  /** A connection and its first token (or a new token for a disconnected one), shown once: a year's life. */
  connect(caller: SsoCaller): Promise<SsoResult<{ token: string; expiresAt: string }>>;
  /** A new token; the old ones stop working at once. Allowed without a license: it's hygiene, not a change. */
  rotate(caller: SsoCaller): Promise<SsoResult<{ token: string; expiresAt: string }>>;
  /** Every token stops working: nobody is added or removed until a new one. People already added stay. */
  disconnect(caller: SsoCaller): Promise<SsoResult<{ tokensRevoked: number }>>;
  /** The role a group gives (null: none), applied to its people at once. */
  mapGroup(caller: SsoCaller, groupId: string, role: ScimRole | null): Promise<SsoResult<null>>;
}

export type SsoStatus = "draft" | "verified" | "active" | "disabled";
export type SsoProtocol = "oidc" | "saml";

/** What the settings page may see of a provider: never its secrets. */
export interface SsoProviderView {
  providerId: string;
  name: string;
  protocol: SsoProtocol;
  /** OIDC: the issuer URL; SAML: the identity provider's entity id. */
  issuer: string;
  domain: string;
  domainVerified: boolean;
  status: SsoStatus;
  enforced: boolean;
  lastTestedAt: string | null;
  updatedAt: string;
  /** Live sessions it signed in. */
  sessions: number;
  /** What requiring it ends, across every workspace on the instance: other sessions and API keys at its domain. */
  otherSessions: number;
  keysAtDomain: number;
  /** Someone has signed in through it, so its identity settings (issuer, client, endpoints) can't change. */
  linked: boolean;
  /** What to paste into the identity provider, built from BETTER_AUTH_URL. */
  endpoints: { oidcRedirect: string; samlAcs: string; samlMetadata: string; entityId: string };
  /** The TXT record that proves the domain: its name and label (what a DNS provider's name field wants). */
  dns: { name: string; label: string };
  /** The non-secret settings, for the edit form. */
  settings: { clientId: string | null; entryPoint: string | null } | null;
}

/** Who is asking, from their browser session (the plugin's in-process calls need its cookie). */
export interface SsoCaller {
  orgId: string;
  userId: string;
  sessionId: string;
  role: string;
  headers: Headers;
}

export type SsoResult<T> = { ok: true; value: T } | { ok: false; code: string; message: string; detail?: string };

export type SsoNewProvider =
  | {
      protocol: "oidc";
      name: string;
      providerId: string;
      domain: string;
      issuer: string;
      clientId: string;
      clientSecret: string;
      /** When the provider's discovery document isn't at `<issuer>/.well-known/openid-configuration`. */
      discoveryUrl?: string;
    }
  | {
      protocol: "saml";
      name: string;
      providerId: string;
      domain: string;
      /** The identity provider's metadata: a URL fetched once, or the XML pasted. */
      metadataUrl?: string;
      metadataXml?: string;
    };

export interface SsoProviderChange {
  name?: string;
  domain?: string;
  issuer?: string;
  clientId?: string;
  discoveryUrl?: string;
  metadataUrl?: string;
  metadataXml?: string;
}

export interface EnterpriseSso {
  /** The organization's providers, and the instance's settings the page shows. */
  list(caller: SsoCaller): Promise<{ providers: SsoProviderView[]; maxAuthAgeHours: number; origin: string }>;
  /** Saves a provider as a draft: no request leaves the server until its domain is proved. */
  create(caller: SsoCaller, input: SsoNewProvider): Promise<SsoResult<SsoProviderView>>;
  /** The TXT record to publish: a token that works for 7 days (a new one once it lapses). */
  dnsRecord(
    caller: SsoCaller,
    providerId: string,
  ): Promise<SsoResult<{ name: string; label: string; value: string | null; expiresAt: string | null }>>;
  /** Asks the domain's own nameservers for the record; verified, the provider signs people in. */
  verify(caller: SsoCaller, providerId: string): Promise<SsoResult<SsoProviderView>>;
  /** After a test sign-in through it, by whoever's session came through it since its last change: active. */
  activate(caller: SsoCaller, providerId: string): Promise<SsoResult<SsoProviderView>>;
  /** Required for everyone at its domain: their other sessions end and their API keys are revoked. */
  enforce(
    caller: SsoCaller,
    providerId: string,
    confirmDomain: string,
  ): Promise<SsoResult<SsoProviderView & { sessionsEnded: number; keysRevoked: number }>>;
  unenforce(caller: SsoCaller, providerId: string): Promise<SsoResult<SsoProviderView>>;
  /** Break-glass, allowed even when the license has lapsed: its sessions end and enforcement lifts. */
  disable(caller: SsoCaller, providerId: string): Promise<SsoResult<SsoProviderView & { sessionsEnded: number }>>;
  enable(caller: SsoCaller, providerId: string): Promise<SsoResult<SsoProviderView>>;
  update(caller: SsoCaller, providerId: string, change: SsoProviderChange): Promise<SsoResult<SsoProviderView>>;
  /** Replaces the client secret (OIDC). Write-only: never shown again. */
  rotateSecret(caller: SsoCaller, providerId: string, clientSecret: string): Promise<SsoResult<null>>;
  remove(caller: SsoCaller, providerId: string): Promise<SsoResult<{ sessionsEnded: number }>>;
  /** For the sign-in page: whether an email's domain signs in through a provider, and must. Cached a minute. */
  discover(email: string): Promise<{ sso: boolean; enforced: boolean }>;
}

/** Runs fn in one short transaction that can read the organization's audit rows: the tenant's, or the system role. */
export type AuditTx = TenantTx | SystemTx;
export type RunAudit = <T>(fn: (tx: AuditTx) => Promise<T>) => Promise<T>;

/** Where an organization's chain stands. */
export interface AuditChainStatus {
  /** The last sealed row's place in the chain (0: nothing sealed yet). */
  seq: number;
  /** Its hash, hex: the chain head. */
  head: string | null;
  sealedAt: string | null;
  /** Rows written but not sealed yet (sealing runs each minute). */
  unsealed: number;
  /** All rows, sealed or not. */
  total: number;
  /** When the organization's history was purged, if it was: the chain starts again there. */
  purgedAt: string | null;
}

export type AuditVerifyResult =
  | {
      ok: true;
      /** Rows checked. */
      checked: number;
      /** Where the walk started: 1, or later when older rows passed the retention. */
      fromSeq: number;
      head: string | null;
      /** Every sealed row has passed the retention: nothing to walk, and its head is still kept. */
      agedOut?: boolean;
    }
  | { ok: false; checked: number; at: { id: string; seq: number }; reason: string };

export interface EnterpriseAudit {
  /**
   * Seals rows written since the last time into each organization's chain, oldest first, a bounded batch per call
   * (the worker's minute tick). Returns how many it sealed.
   */
  seal(withSystem: <T>(fn: (tx: SystemTx) => Promise<T>) => Promise<T>): Promise<{ orgs: number; rows: number }>;
  status(run: RunAudit, orgId: string): Promise<AuditChainStatus>;
  /** Walks the organization's chain from its first remaining row and says whether every link holds. */
  verify(run: RunAudit, orgId: string): Promise<AuditVerifyResult>;
  /**
   * The organization's rows since `since`, as CSV or JSON Lines, each with its place and hash in the chain, and the
   * chain head first (so a copy of it lives outside the database).
   */
  export(
    run: RunAudit,
    orgId: string,
    options: { format: "csv" | "jsonl"; since: Date },
  ): AsyncGenerator<string, { rows: number }, undefined>;
}

/** A build without ee/ (its apps' enterprise.ts export this instead). */
export const communityEdition = (production: boolean): Enterprise => ({
  production,
  status: () => ({ state: "community" }),
  canChange: () => false,
});

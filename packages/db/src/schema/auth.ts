/**
 * Better Auth tables (schema `auth`). Curated from the CLI output in
 * packages/auth/generated/better-auth-schema.reference.ts (`pnpm --filter @opendash/auth generate:schema`):
 *   - tables live in the `auth` schema (the CLI ignores schemaName for Drizzle in 1.7.7);
 *   - ids and id foreign keys are uuid (Better Auth generates uuidv7 via advanced.database.generateId);
 *   - timestamps are timezone-aware.
 * After a Better Auth upgrade, regenerate the reference and diff it against this file.
 *
 * Access: Better Auth connects as opendash_auth. opendash_app and opendash_system have no privileges in this schema;
 * tenant context comes from packages/auth (resolveTenant), never from app queries on these tables.
 */
import { relations, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const authSchema = pgSchema("auth");

export const user = authSchema.table("user", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  /** Two-factor sign-in: on once a code from the app confirmed it. */
  twoFactorEnabled: boolean("two_factor_enabled").default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
});

export const session = authSchema.table(
  "session",
  {
    id: uuid("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    activeOrganizationId: uuid("active_organization_id"),
    activeTeamId: uuid("active_team_id"),
    /**
     * How the session was made, written only by the server's own hooks: "sso" with the provider and the moment the
     * identity provider vouched for the person. Single sign-on enforcement reads them on every request (ee/).
     */
    authenticationMethod: text("authentication_method"),
    ssoProviderId: text("sso_provider_id").references(() => ssoProvider.providerId, { onDelete: "cascade" }),
    authenticatedAt: timestamp("authenticated_at", { withTimezone: true }),
  },
  (table) => [index("session_userId_idx").on(table.userId), index("session_ssoProviderId_idx").on(table.ssoProviderId)],
);

export const account = authSchema.table(
  "account",
  {
    id: uuid("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("account_userId_idx").on(table.userId)],
);

export const verification = authSchema.table(
  "verification",
  {
    // Text, not uuid: Better Auth writes lock rows here with a SHA-256 id (reserveVerificationValue, used when an
    // email link claims an unverified account).
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

// Rate-limit counters (Better Auth `rateLimit.storage: "database"`), so limits hold across restarts and replicas.
export const rateLimit = authSchema.table("rate_limit", {
  id: uuid("id").primaryKey(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  lastRequest: bigint("last_request", { mode: "number" }).notNull(),
});

export const organization = authSchema.table("organization", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logo: text("logo"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  metadata: text("metadata"),
});

export const team = authSchema.table(
  "team",
  {
    id: uuid("id").primaryKey(),
    name: text("name").notNull(),
    memberCount: integer("member_count").default(0).notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).$onUpdate(() => /* @__PURE__ */ new Date()),
  },
  (table) => [index("team_organizationId_idx").on(table.organizationId)],
);

export const teamMember = authSchema.table(
  "team_member",
  {
    id: uuid("id").primaryKey(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    membershipKey: text("membership_key").unique(),
    createdAt: timestamp("created_at", { withTimezone: true }),
  },
  (table) => [index("teamMember_teamId_idx").on(table.teamId), index("teamMember_userId_idx").on(table.userId)],
);

export const member = authSchema.table(
  "member",
  {
    id: uuid("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").default("member").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("member_organizationId_idx").on(table.organizationId),
    index("member_userId_idx").on(table.userId),
    // One membership per person per organization, as Better Auth keeps it: what app.slack_identity's foreign key
    // points at, so removing someone unlinks their Slack account.
    uniqueIndex("member_organization_user_uq").on(table.organizationId, table.userId),
  ],
);

export const invitation = authSchema.table(
  "invitation",
  {
    id: uuid("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role"),
    teamId: uuid("team_id"),
    status: text("status").default("pending").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    inviterId: uuid("inviter_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [
    index("invitation_organizationId_idx").on(table.organizationId),
    index("invitation_email_idx").on(table.email),
  ],
);

export const apikey = authSchema.table(
  "apikey",
  {
    id: uuid("id").primaryKey(),
    configId: text("config_id").default("default").notNull(),
    name: text("name"),
    start: text("start"),
    referenceId: uuid("reference_id").notNull(),
    prefix: text("prefix"),
    key: text("key").notNull(),
    refillInterval: integer("refill_interval"),
    refillAmount: integer("refill_amount"),
    lastRefillAt: timestamp("last_refill_at", { withTimezone: true }),
    enabled: boolean("enabled").default(true),
    rateLimitEnabled: boolean("rate_limit_enabled").default(true),
    rateLimitTimeWindow: integer("rate_limit_time_window").default(86400000),
    rateLimitMax: integer("rate_limit_max").default(10),
    requestCount: integer("request_count").default(0),
    remaining: integer("remaining"),
    lastRequest: timestamp("last_request", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    permissions: text("permissions"),
    metadata: text("metadata"),
  },
  (table) => [
    index("apikey_configId_idx").on(table.configId),
    index("apikey_referenceId_idx").on(table.referenceId),
    index("apikey_key_idx").on(table.key),
  ],
);

/**
 * The two-factor plugin's secrets: the TOTP key and the backup codes, both encrypted under the auth secret by Better
 * Auth. `verified` is false between "turn on" and the first code; wrong codes count towards `locked_until`.
 */
export const twoFactor = authSchema.table(
  "two_factor",
  {
    id: uuid("id").primaryKey(),
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    verified: boolean("verified").default(true),
    failedVerificationCount: integer("failed_verification_count").default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
  },
  (table) => [index("twoFactor_secret_idx").on(table.secret), index("twoFactor_userId_idx").on(table.userId)],
);

/**
 * A domain an organization has proved by DNS for single sign-on (ee/): one organization per domain, so no two
 * workspaces can sign the same people in or enforce on them. Its providers point at it while they're verified (the
 * foreign key below), so the rule holds whichever code path verifies a provider, and an organization can verify a
 * second provider for its domain (moving from one identity provider to another).
 */
export const ssoDomain = authSchema.table(
  "sso_domain",
  {
    domain: text("domain").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [unique("sso_domain_domain_organization_uq").on(table.domain, table.organizationId)],
);

/**
 * The single sign-on plugin's providers (`@better-auth/sso`, in ee/): its fields first, then the lifecycle that
 * ee/ adds (status, enforcement, the passed test sign-in). `oidc_config` and `saml_config` are JSON that ee/ seals
 * with the organization's data key before Better Auth writes them, so the client secret and keys are never stored in
 * the clear.
 */
export const ssoProvider = authSchema.table(
  "sso_provider",
  {
    id: uuid("id").primaryKey(),
    issuer: text("issuer").notNull(),
    oidcConfig: text("oidc_config"),
    samlConfig: text("saml_config"),
    /** Who registered it. Kept when they leave: the provider is the organization's. */
    userId: uuid("user_id").references(() => user.id, { onDelete: "set null" }),
    /** In the addresses the identity provider calls back, so it never changes. */
    providerId: text("provider_id").notNull().unique(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** Exactly one email domain, lowercase: a subdomain needs its own provider. */
    domain: text("domain").notNull(),
    domainVerified: boolean("domain_verified").default(false).notNull(),
    /** What people see on the settings page ("Okta"). */
    name: text("name").default("").notNull(),
    status: text("status").default("draft").notNull(),
    enforceSso: boolean("enforce_sso").default(false).notNull(),
    /** The role someone new to the workspace gets when they first sign in through it (an invitation's role wins). */
    joinRole: text("join_role").default("viewer").notNull(),
    lastTestedAt: timestamp("last_tested_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    /** The domain while it's verified, else null: what the claim's foreign key checks. */
    verifiedDomain: text("verified_domain").generatedAlwaysAs(sql`case when domain_verified then domain end`),
  },
  (table) => [
    index("ssoProvider_organizationId_idx").on(table.organizationId),
    index("ssoProvider_domain_idx").on(table.domain),
    // A verified provider's domain must be its organization's claim (null while unverified: no check).
    foreignKey({
      name: "sso_provider_verified_domain_claim_fk",
      columns: [table.verifiedDomain, table.organizationId],
      foreignColumns: [ssoDomain.domain, ssoDomain.organizationId],
    }),
    // One enforcing provider per domain: enforcement compares a session's provider with "the" enforcing one.
    uniqueIndex("sso_provider_one_enforcer_per_domain_uq").on(table.domain).where(sql`enforce_sso`),
    check("sso_provider_status_ck", sql`${table.status} in ('draft', 'verified', 'active', 'disabled')`),
    // Never admin or owner by default: that would make everyone at the domain one.
    check("sso_provider_join_role_ck", sql`${table.joinRole} in ('viewer', 'member')`),
    // Enforcement needs a proved domain and a passed test sign-in, so an untested provider is never the only way in.
    check(
      "sso_provider_enforce_requires_active_ck",
      sql`not ${table.enforceSso} or (${table.domainVerified} and ${table.status} = 'active')`,
    ),
    check("sso_provider_domain_ck", sql`${table.domain} ~ '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$'`),
  ],
);

/*
 * Directory sync's tables (`@better-auth/scim`, in ee/): its managed connections and their hashed tokens, the SCIM
 * users and groups a directory pushed, and the role grants projected from them. Curated from the plugin's generated
 * schema (ids and user references uuid, timestamps with time zone); what a person may do comes from the organization's
 * membership, which ee/ keeps in step (scimGroupRole below says how groups map to roles).
 */
export const scimManagedConnection = authSchema.table(
  "scim_managed_connection",
  {
    id: uuid("id").primaryKey(),
    creationRequestId: text("creation_request_id").notNull().unique(),
    connectionId: text("connection_id").notNull().unique(),
    provisioningDomainId: text("provisioning_domain_id").notNull(),
    status: text("status").notNull(),
    revision: integer("revision").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    createdBy: text("created_by").notNull(),
    decommissionStartedAt: timestamp("decommission_started_at", { withTimezone: true }),
    decommissionStartedBy: text("decommission_started_by"),
    decommissionedAt: timestamp("decommissioned_at", { withTimezone: true }),
    decommissionedBy: text("decommissioned_by"),
  },
  (table) => [index("scimManagedConnection_provisioningDomainId_idx").on(table.provisioningDomainId)],
);

export const scimManagedCredential = authSchema.table(
  "scim_managed_credential",
  {
    id: uuid("id").primaryKey(),
    connectionRecordId: uuid("connection_record_id")
      .notNull()
      .references(() => scimManagedConnection.id, { onDelete: "cascade" }),
    credentialId: text("credential_id").notNull().unique(),
    tokenDigest: text("token_digest").notNull(),
    hashVersion: text("hash_version").notNull(),
    activeSlotKey: text("active_slot_key").notNull().unique(),
    status: text("status").notNull(),
    serializedScopes: text("serialized_scopes").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    createdBy: text("created_by").notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: text("revoked_by"),
    decommissionedAt: timestamp("decommissioned_at", { withTimezone: true }),
  },
  (table) => [index("scimManagedCredential_connectionRecordId_idx").on(table.connectionRecordId)],
);

export const scimManagedConnectionEvent = authSchema.table(
  "scim_managed_connection_event",
  {
    id: uuid("id").primaryKey(),
    connectionRecordId: uuid("connection_record_id")
      .notNull()
      .references(() => scimManagedConnection.id, { onDelete: "cascade" }),
    eventKey: text("event_key").notNull().unique(),
    sequence: integer("sequence").notNull(),
    type: text("type").notNull(),
    actorId: text("actor_id").notNull(),
    credentialId: text("credential_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("scimManagedConnectionEvent_connectionRecordId_idx").on(table.connectionRecordId)],
);

export const scimConnectionBinding = authSchema.table(
  "scim_connection_binding",
  {
    id: uuid("id").primaryKey(),
    connectionId: text("connection_id").notNull(),
    connectionKey: text("connection_key").notNull().unique(),
    provisioningDomainId: text("provisioning_domain_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    decommissionedAt: timestamp("decommissioned_at", { withTimezone: true }),
    decommissionStatus: text("decommission_status").default("active").notNull(),
    decommissionCursorUserId: text("decommission_cursor_user_id"),
    decommissionReconciledUserCount: integer("decommission_reconciled_user_count").default(0).notNull(),
    decommissionBatchCount: integer("decommission_batch_count").default(0).notNull(),
    decommissionRevision: integer("decommission_revision").default(0).notNull(),
    decommissionCompletedAt: timestamp("decommission_completed_at", { withTimezone: true }),
    decommissionLeaseId: text("decommission_lease_id"),
    decommissionLeaseExpiresAt: timestamp("decommission_lease_expires_at", { withTimezone: true }),
  },
  (table) => [index("scimConnectionBinding_connectionId_idx").on(table.connectionId)],
);

export const scimIdentityTombstone = authSchema.table(
  "scim_identity_tombstone",
  {
    id: uuid("id").primaryKey(),
    connectionId: text("connection_id").notNull(),
    provisioningDomainId: text("provisioning_domain_id").notNull(),
    externalId: text("external_id").notNull(),
    externalIdKey: text("external_id_key").notNull().unique(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    profile: text("profile").notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("scimIdentityTombstone_connectionId_idx").on(table.connectionId),
    index("scimIdentityTombstone_provisioningDomainId_idx").on(table.provisioningDomainId),
    index("scimIdentityTombstone_userId_idx").on(table.userId),
  ],
);

export const scimSubject = authSchema.table(
  "scim_subject",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .unique()
      .references(() => user.id, { onDelete: "cascade" }),
    profileSourceId: text("profile_source_id"),
    revision: integer("revision").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("scimSubject_profileSourceId_idx").on(table.profileSourceId)],
);

export const scimUser = authSchema.table(
  "scim_user",
  {
    id: uuid("id").primaryKey(),
    connectionId: text("connection_id").notNull(),
    provisioningDomainId: text("provisioning_domain_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    connectionUserKey: text("connection_user_key").notNull().unique(),
    userName: text("user_name").notNull(),
    userNameKey: text("user_name_key").notNull().unique(),
    primaryEmail: text("primary_email").notNull(),
    workEmailValueIndex: text("work_email_value_index").notNull(),
    emailValueIndex: text("email_value_index").notNull(),
    displayName: text("display_name").notNull(),
    formattedName: text("formatted_name").notNull(),
    givenName: text("given_name"),
    familyName: text("family_name"),
    serializedEmails: text("serialized_emails").notNull(),
    serializedAttributes: text("serialized_attributes"),
    externalId: text("external_id"),
    externalIdKey: text("external_id_key").unique(),
    active: boolean("active").notNull(),
    orderKey: text("order_key").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("scimUser_connectionId_idx").on(table.connectionId),
    index("scimUser_provisioningDomainId_idx").on(table.provisioningDomainId),
    index("scimUser_userId_idx").on(table.userId),
  ],
);

export const scimProjectionGrant = authSchema.table(
  "scim_projection_grant",
  {
    id: uuid("id").primaryKey(),
    connectionId: text("connection_id").notNull(),
    provisioningDomainId: text("provisioning_domain_id").notNull(),
    scimUserId: uuid("scim_user_id")
      .notNull()
      .references(() => scimUser.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    sourceKind: text("source_kind").notNull(),
    sourceId: text("source_id").notNull(),
    sourceValue: text("source_value"),
    role: text("role").notNull(),
    grantKey: text("grant_key").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("scimProjectionGrant_connectionId_idx").on(table.connectionId),
    index("scimProjectionGrant_provisioningDomainId_idx").on(table.provisioningDomainId),
    index("scimProjectionGrant_scimUserId_idx").on(table.scimUserId),
    index("scimProjectionGrant_userId_idx").on(table.userId),
  ],
);

export const scimGroup = authSchema.table(
  "scim_group",
  {
    id: uuid("id").primaryKey(),
    connectionId: text("connection_id").notNull(),
    provisioningDomainId: text("provisioning_domain_id").notNull(),
    revision: integer("revision").default(0).notNull(),
    displayName: text("display_name").notNull(),
    displayNameKey: text("display_name_key").notNull().unique(),
    externalId: text("external_id"),
    externalIdKey: text("external_id_key").unique(),
    orderKey: text("order_key").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("scimGroup_connectionId_idx").on(table.connectionId),
    index("scimGroup_provisioningDomainId_idx").on(table.provisioningDomainId),
  ],
);

export const scimGroupMember = authSchema.table(
  "scim_group_member",
  {
    id: uuid("id").primaryKey(),
    connectionId: text("connection_id").notNull(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => scimGroup.id, { onDelete: "cascade" }),
    scimUserId: uuid("scim_user_id")
      .notNull()
      .references(() => scimUser.id, { onDelete: "cascade" }),
    membershipKey: text("membership_key").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("scimGroupMember_connectionId_idx").on(table.connectionId),
    index("scimGroupMember_groupId_idx").on(table.groupId),
    index("scimGroupMember_scimUserId_idx").on(table.scimUserId),
  ],
);

/** An organization's mapping from a directory group (the plugin's group id) to a role: admin, member or viewer. */
export const scimGroupRole = authSchema.table(
  "scim_group_role",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    groupId: uuid("group_id")
      .notNull()
      .references(() => scimGroup.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.groupId] }),
    // Owner is only ever given by hand.
    check("scim_group_role_role_ck", sql`${table.role} in ('admin', 'member', 'viewer')`),
  ],
);

/**
 * The role directory sync last gave a person in a workspace (ee/). It changes only roles it gave: a role set by hand
 * stays until a mapped group says otherwise, and leaving a mapped group takes away only what that group gave.
 */
export const scimMemberRole = authSchema.table(
  "scim_member_role",
  {
    id: uuid("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("scim_member_role_organization_user_uq").on(table.organizationId, table.userId)],
);

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
  teamMembers: many(teamMember),
  members: many(member),
  invitations: many(invitation),
  twoFactors: many(twoFactor),
}));

export const twoFactorRelations = relations(twoFactor, ({ one }) => ({
  user: one(user, {
    fields: [twoFactor.userId],
    references: [user.id],
  }),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, {
    fields: [session.userId],
    references: [user.id],
  }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, {
    fields: [account.userId],
    references: [user.id],
  }),
}));

export const organizationRelations = relations(organization, ({ many }) => ({
  teams: many(team),
  members: many(member),
  invitations: many(invitation),
}));

export const teamRelations = relations(team, ({ one, many }) => ({
  organization: one(organization, {
    fields: [team.organizationId],
    references: [organization.id],
  }),
  teamMembers: many(teamMember),
}));

export const teamMemberRelations = relations(teamMember, ({ one }) => ({
  team: one(team, {
    fields: [teamMember.teamId],
    references: [team.id],
  }),
  user: one(user, {
    fields: [teamMember.userId],
    references: [user.id],
  }),
}));

export const memberRelations = relations(member, ({ one }) => ({
  organization: one(organization, {
    fields: [member.organizationId],
    references: [organization.id],
  }),
  user: one(user, {
    fields: [member.userId],
    references: [user.id],
  }),
}));

export const invitationRelations = relations(invitation, ({ one }) => ({
  organization: one(organization, {
    fields: [invitation.organizationId],
    references: [organization.id],
  }),
  user: one(user, {
    fields: [invitation.inviterId],
    references: [user.id],
  }),
}));

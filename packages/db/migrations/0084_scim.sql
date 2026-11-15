CREATE TABLE "auth"."scim_connection_binding" (
	"id" uuid PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"connection_key" text NOT NULL,
	"provisioning_domain_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"decommissioned_at" timestamp with time zone,
	"decommission_status" text DEFAULT 'active' NOT NULL,
	"decommission_cursor_user_id" text,
	"decommission_reconciled_user_count" integer DEFAULT 0 NOT NULL,
	"decommission_batch_count" integer DEFAULT 0 NOT NULL,
	"decommission_revision" integer DEFAULT 0 NOT NULL,
	"decommission_completed_at" timestamp with time zone,
	"decommission_lease_id" text,
	"decommission_lease_expires_at" timestamp with time zone,
	CONSTRAINT "scim_connection_binding_connection_key_unique" UNIQUE("connection_key")
);
--> statement-breakpoint
CREATE TABLE "auth"."scim_group" (
	"id" uuid PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"provisioning_domain_id" text NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"display_name" text NOT NULL,
	"display_name_key" text NOT NULL,
	"external_id" text,
	"external_id_key" text,
	"order_key" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "scim_group_display_name_key_unique" UNIQUE("display_name_key"),
	CONSTRAINT "scim_group_external_id_key_unique" UNIQUE("external_id_key"),
	CONSTRAINT "scim_group_order_key_unique" UNIQUE("order_key")
);
--> statement-breakpoint
CREATE TABLE "auth"."scim_group_member" (
	"id" uuid PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"group_id" uuid NOT NULL,
	"scim_user_id" uuid NOT NULL,
	"membership_key" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "scim_group_member_membership_key_unique" UNIQUE("membership_key")
);
--> statement-breakpoint
CREATE TABLE "auth"."scim_group_role" (
	"organization_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"role" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scim_group_role_organization_id_group_id_pk" PRIMARY KEY("organization_id","group_id"),
	CONSTRAINT "scim_group_role_role_ck" CHECK ("auth"."scim_group_role"."role" in ('admin', 'member', 'viewer'))
);
--> statement-breakpoint
CREATE TABLE "auth"."scim_identity_tombstone" (
	"id" uuid PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"provisioning_domain_id" text NOT NULL,
	"external_id" text NOT NULL,
	"external_id_key" text NOT NULL,
	"user_id" uuid NOT NULL,
	"profile" text NOT NULL,
	"deleted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "scim_identity_tombstone_external_id_key_unique" UNIQUE("external_id_key")
);
--> statement-breakpoint
CREATE TABLE "auth"."scim_managed_connection" (
	"id" uuid PRIMARY KEY NOT NULL,
	"creation_request_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"provisioning_domain_id" text NOT NULL,
	"status" text NOT NULL,
	"revision" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"created_by" text NOT NULL,
	"decommission_started_at" timestamp with time zone,
	"decommission_started_by" text,
	"decommissioned_at" timestamp with time zone,
	"decommissioned_by" text,
	CONSTRAINT "scim_managed_connection_creation_request_id_unique" UNIQUE("creation_request_id"),
	CONSTRAINT "scim_managed_connection_connection_id_unique" UNIQUE("connection_id")
);
--> statement-breakpoint
CREATE TABLE "auth"."scim_managed_connection_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"connection_record_id" uuid NOT NULL,
	"event_key" text NOT NULL,
	"sequence" integer NOT NULL,
	"type" text NOT NULL,
	"actor_id" text NOT NULL,
	"credential_id" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "scim_managed_connection_event_event_key_unique" UNIQUE("event_key")
);
--> statement-breakpoint
CREATE TABLE "auth"."scim_managed_credential" (
	"id" uuid PRIMARY KEY NOT NULL,
	"connection_record_id" uuid NOT NULL,
	"credential_id" text NOT NULL,
	"token_digest" text NOT NULL,
	"hash_version" text NOT NULL,
	"active_slot_key" text NOT NULL,
	"status" text NOT NULL,
	"serialized_scopes" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"created_by" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"decommissioned_at" timestamp with time zone,
	CONSTRAINT "scim_managed_credential_credential_id_unique" UNIQUE("credential_id"),
	CONSTRAINT "scim_managed_credential_active_slot_key_unique" UNIQUE("active_slot_key")
);
--> statement-breakpoint
CREATE TABLE "auth"."scim_projection_grant" (
	"id" uuid PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"provisioning_domain_id" text NOT NULL,
	"scim_user_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" text NOT NULL,
	"source_value" text,
	"role" text NOT NULL,
	"grant_key" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "scim_projection_grant_grant_key_unique" UNIQUE("grant_key")
);
--> statement-breakpoint
CREATE TABLE "auth"."scim_subject" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"profile_source_id" text,
	"revision" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "scim_subject_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "auth"."scim_user" (
	"id" uuid PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"provisioning_domain_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"connection_user_key" text NOT NULL,
	"user_name" text NOT NULL,
	"user_name_key" text NOT NULL,
	"primary_email" text NOT NULL,
	"work_email_value_index" text NOT NULL,
	"email_value_index" text NOT NULL,
	"display_name" text NOT NULL,
	"formatted_name" text NOT NULL,
	"given_name" text,
	"family_name" text,
	"serialized_emails" text NOT NULL,
	"serialized_attributes" text,
	"external_id" text,
	"external_id_key" text,
	"active" boolean NOT NULL,
	"order_key" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "scim_user_connection_user_key_unique" UNIQUE("connection_user_key"),
	CONSTRAINT "scim_user_user_name_key_unique" UNIQUE("user_name_key"),
	CONSTRAINT "scim_user_external_id_key_unique" UNIQUE("external_id_key"),
	CONSTRAINT "scim_user_order_key_unique" UNIQUE("order_key")
);
--> statement-breakpoint
ALTER TABLE "auth"."scim_group_member" ADD CONSTRAINT "scim_group_member_group_id_scim_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "auth"."scim_group"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."scim_group_member" ADD CONSTRAINT "scim_group_member_scim_user_id_scim_user_id_fk" FOREIGN KEY ("scim_user_id") REFERENCES "auth"."scim_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."scim_group_role" ADD CONSTRAINT "scim_group_role_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."scim_group_role" ADD CONSTRAINT "scim_group_role_group_id_scim_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "auth"."scim_group"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."scim_identity_tombstone" ADD CONSTRAINT "scim_identity_tombstone_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."scim_managed_connection_event" ADD CONSTRAINT "scim_managed_connection_event_connection_record_id_scim_managed_connection_id_fk" FOREIGN KEY ("connection_record_id") REFERENCES "auth"."scim_managed_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."scim_managed_credential" ADD CONSTRAINT "scim_managed_credential_connection_record_id_scim_managed_connection_id_fk" FOREIGN KEY ("connection_record_id") REFERENCES "auth"."scim_managed_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."scim_projection_grant" ADD CONSTRAINT "scim_projection_grant_scim_user_id_scim_user_id_fk" FOREIGN KEY ("scim_user_id") REFERENCES "auth"."scim_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."scim_projection_grant" ADD CONSTRAINT "scim_projection_grant_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."scim_subject" ADD CONSTRAINT "scim_subject_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."scim_user" ADD CONSTRAINT "scim_user_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scimConnectionBinding_connectionId_idx" ON "auth"."scim_connection_binding" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "scimGroup_connectionId_idx" ON "auth"."scim_group" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "scimGroup_provisioningDomainId_idx" ON "auth"."scim_group" USING btree ("provisioning_domain_id");--> statement-breakpoint
CREATE INDEX "scimGroupMember_connectionId_idx" ON "auth"."scim_group_member" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "scimGroupMember_groupId_idx" ON "auth"."scim_group_member" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "scimGroupMember_scimUserId_idx" ON "auth"."scim_group_member" USING btree ("scim_user_id");--> statement-breakpoint
CREATE INDEX "scimIdentityTombstone_connectionId_idx" ON "auth"."scim_identity_tombstone" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "scimIdentityTombstone_provisioningDomainId_idx" ON "auth"."scim_identity_tombstone" USING btree ("provisioning_domain_id");--> statement-breakpoint
CREATE INDEX "scimIdentityTombstone_userId_idx" ON "auth"."scim_identity_tombstone" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "scimManagedConnection_provisioningDomainId_idx" ON "auth"."scim_managed_connection" USING btree ("provisioning_domain_id");--> statement-breakpoint
CREATE INDEX "scimManagedConnectionEvent_connectionRecordId_idx" ON "auth"."scim_managed_connection_event" USING btree ("connection_record_id");--> statement-breakpoint
CREATE INDEX "scimManagedCredential_connectionRecordId_idx" ON "auth"."scim_managed_credential" USING btree ("connection_record_id");--> statement-breakpoint
CREATE INDEX "scimProjectionGrant_connectionId_idx" ON "auth"."scim_projection_grant" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "scimProjectionGrant_provisioningDomainId_idx" ON "auth"."scim_projection_grant" USING btree ("provisioning_domain_id");--> statement-breakpoint
CREATE INDEX "scimProjectionGrant_scimUserId_idx" ON "auth"."scim_projection_grant" USING btree ("scim_user_id");--> statement-breakpoint
CREATE INDEX "scimProjectionGrant_userId_idx" ON "auth"."scim_projection_grant" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "scimSubject_profileSourceId_idx" ON "auth"."scim_subject" USING btree ("profile_source_id");--> statement-breakpoint
CREATE INDEX "scimUser_connectionId_idx" ON "auth"."scim_user" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "scimUser_provisioningDomainId_idx" ON "auth"."scim_user" USING btree ("provisioning_domain_id");--> statement-breakpoint
CREATE INDEX "scimUser_userId_idx" ON "auth"."scim_user" USING btree ("user_id");
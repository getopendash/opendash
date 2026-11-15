CREATE TABLE "auth"."sso_domain" (
	"domain" text PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sso_domain_domain_organization_uq" UNIQUE("domain","organization_id")
);
--> statement-breakpoint
CREATE TABLE "auth"."sso_provider" (
	"id" uuid PRIMARY KEY NOT NULL,
	"issuer" text NOT NULL,
	"oidc_config" text,
	"saml_config" text,
	"user_id" uuid,
	"provider_id" text NOT NULL,
	"organization_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"domain_verified" boolean DEFAULT false NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"enforce_sso" boolean DEFAULT false NOT NULL,
	"last_tested_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_domain" text GENERATED ALWAYS AS (case when domain_verified then domain end) STORED,
	CONSTRAINT "sso_provider_provider_id_unique" UNIQUE("provider_id"),
	CONSTRAINT "sso_provider_status_ck" CHECK ("auth"."sso_provider"."status" in ('draft', 'verified', 'active', 'disabled')),
	CONSTRAINT "sso_provider_enforce_requires_active_ck" CHECK (not "auth"."sso_provider"."enforce_sso" or ("auth"."sso_provider"."domain_verified" and "auth"."sso_provider"."status" = 'active')),
	CONSTRAINT "sso_provider_domain_ck" CHECK ("auth"."sso_provider"."domain" ~ '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$')
);
--> statement-breakpoint
ALTER TABLE "auth"."session" ADD COLUMN "authentication_method" text;--> statement-breakpoint
ALTER TABLE "auth"."session" ADD COLUMN "sso_provider_id" text;--> statement-breakpoint
ALTER TABLE "auth"."session" ADD COLUMN "authenticated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "auth"."sso_domain" ADD CONSTRAINT "sso_domain_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."sso_provider" ADD CONSTRAINT "sso_provider_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."sso_provider" ADD CONSTRAINT "sso_provider_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."sso_provider" ADD CONSTRAINT "sso_provider_verified_domain_claim_fk" FOREIGN KEY ("verified_domain","organization_id") REFERENCES "auth"."sso_domain"("domain","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ssoProvider_organizationId_idx" ON "auth"."sso_provider" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "ssoProvider_domain_idx" ON "auth"."sso_provider" USING btree ("domain");--> statement-breakpoint
CREATE UNIQUE INDEX "sso_provider_one_enforcer_per_domain_uq" ON "auth"."sso_provider" USING btree ("domain") WHERE enforce_sso;--> statement-breakpoint
ALTER TABLE "auth"."session" ADD CONSTRAINT "session_sso_provider_id_sso_provider_provider_id_fk" FOREIGN KEY ("sso_provider_id") REFERENCES "auth"."sso_provider"("provider_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_ssoProviderId_idx" ON "auth"."session" USING btree ("sso_provider_id");
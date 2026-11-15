CREATE SCHEMA IF NOT EXISTS "app";
--> statement-breakpoint
CREATE TABLE "app"."entitlement" (
	"org_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"source" text DEFAULT 'plan' NOT NULL,
	"valid_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entitlement_org_id_key_pk" PRIMARY KEY("org_id","key"),
	CONSTRAINT "entitlement_source_check" CHECK ("app"."entitlement"."source" in ('plan', 'override', 'license'))
);
--> statement-breakpoint
ALTER TABLE "app"."entitlement" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."member_pref" (
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"tz" text DEFAULT 'UTC' NOT NULL,
	"push_budget_per_day" smallint DEFAULT 1 NOT NULL,
	"push_budget_per_week" smallint DEFAULT 3 NOT NULL,
	"quiet_hours" jsonb,
	"min_push_severity" smallint DEFAULT 3 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_pref_org_id_user_id_pk" PRIMARY KEY("org_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "app"."member_pref" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."org" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"plan" text DEFAULT 'free' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"region" text,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"billing_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_status_check" CHECK ("app"."org"."status" in ('active', 'suspended', 'deleting'))
);
--> statement-breakpoint
ALTER TABLE "app"."org" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."org_key" (
	"org_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"wrapped_dek" text NOT NULL,
	"kek_ref" text NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_key_org_id_version_pk" PRIMARY KEY("org_id","version"),
	CONSTRAINT "org_key_state_check" CHECK ("app"."org_key"."state" in ('active', 'retired', 'destroyed'))
);
--> statement-breakpoint
ALTER TABLE "app"."org_key" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."user_mark" (
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"mark" text NOT NULL,
	"until_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_mark_org_id_user_id_target_type_target_id_mark_pk" PRIMARY KEY("org_id","user_id","target_type","target_id","mark"),
	CONSTRAINT "user_mark_mark_check" CHECK ("app"."user_mark"."mark" in ('favorite', 'seen', 'dismissed', 'snoozed'))
);
--> statement-breakpoint
ALTER TABLE "app"."user_mark" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."entitlement" ADD CONSTRAINT "entitlement_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."member_pref" ADD CONSTRAINT "member_pref_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."org_key" ADD CONSTRAINT "org_key_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."user_mark" ADD CONSTRAINT "user_mark_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."entitlement" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."entitlement" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."member_pref" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."member_pref" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."org" AS PERMISSIVE FOR ALL TO "opendash_app" USING (id = (select app.org_id())) WITH CHECK (id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."org" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."org_key" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."org_key" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."user_mark" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."user_mark" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);
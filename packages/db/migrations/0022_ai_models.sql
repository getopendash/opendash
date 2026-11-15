CREATE TABLE "app"."ai_key" (
	"org_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"secret_id" uuid NOT NULL,
	"last4" text NOT NULL,
	"status" text DEFAULT 'testing' NOT NULL,
	"message" text,
	"tested_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_key_org_id_provider_pk" PRIMARY KEY("org_id","provider"),
	CONSTRAINT "ai_key_provider_check" CHECK ("app"."ai_key"."provider" in ('anthropic', 'openai', 'google')),
	CONSTRAINT "ai_key_status_check" CHECK ("app"."ai_key"."status" in ('testing', 'ok', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "app"."ai_key" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."ai_settings" (
	"org_id" uuid NOT NULL,
	"default_model" text NOT NULL,
	"offered" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_settings_org_id_pk" PRIMARY KEY("org_id")
);
--> statement-breakpoint
ALTER TABLE "app"."ai_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."ai_key" ADD CONSTRAINT "ai_key_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."ai_key" ADD CONSTRAINT "ai_key_org_id_secret_id_secret_org_id_id_fk" FOREIGN KEY ("org_id","secret_id") REFERENCES "app"."secret"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."ai_settings" ADD CONSTRAINT "ai_settings_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."ai_key" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."ai_key" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."ai_settings" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."ai_settings" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);--> statement-breakpoint
-- Whose key paid for a model call: the organization's own, or the deployment's. usage_event is
-- partitioned (hand-written, outside drizzle-kit); a column added to the parent reaches every partition.
alter table app.usage_event add column key_source text;

CREATE TABLE "app"."ai_provider_test" (
	"org_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"kind" text NOT NULL,
	"secret_id" uuid NOT NULL,
	"shown" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'testing' NOT NULL,
	"message" text,
	"available" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"requested_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"used_at" timestamp with time zone,
	CONSTRAINT "ai_provider_test_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "ai_provider_test_kind_check" CHECK ("app"."ai_provider_test"."kind" in ('opendash', 'gateway', 'openrouter', 'anthropic', 'openai', 'google', 'bedrock', 'vertex') and "app"."ai_provider_test"."kind" <> 'opendash'),
	CONSTRAINT "ai_provider_test_status_check" CHECK ("app"."ai_provider_test"."status" in ('testing', 'ok', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "app"."ai_provider_test" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."ai_provider_test" ADD CONSTRAINT "ai_provider_test_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."ai_provider_test" ADD CONSTRAINT "ai_provider_test_org_id_secret_id_secret_org_id_id_fk" FOREIGN KEY ("org_id","secret_id") REFERENCES "app"."secret"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."ai_provider_test" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."ai_provider_test" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);
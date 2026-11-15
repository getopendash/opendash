CREATE TABLE "app"."ai_provider" (
	"org_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"kind" text NOT NULL,
	"secret_id" uuid,
	"shown" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'testing' NOT NULL,
	"message" text,
	"tested_at" timestamp with time zone,
	"available" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"listed_at" timestamp with time zone,
	"picked" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_provider_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "ai_provider_kind_check" CHECK ("app"."ai_provider"."kind" in ('opendash', 'gateway', 'openrouter', 'anthropic', 'openai', 'google', 'bedrock', 'vertex')),
	CONSTRAINT "ai_provider_status_check" CHECK ("app"."ai_provider"."status" in ('testing', 'ok', 'failed')),
	CONSTRAINT "ai_provider_secret_check" CHECK (("app"."ai_provider"."kind" = 'opendash') = ("app"."ai_provider"."secret_id" is null))
);
--> statement-breakpoint
ALTER TABLE "app"."ai_provider" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- Providers are connections: a workspace's own keys go with ai_key, their sealed secrets too.
WITH gone AS (DELETE FROM app.ai_key RETURNING org_id, secret_id)
DELETE FROM app.secret s USING gone WHERE s.org_id = gone.org_id AND s.id = gone.secret_id;--> statement-breakpoint
DROP POLICY "tenant" ON "app"."ai_key" CASCADE;--> statement-breakpoint
DROP POLICY "system" ON "app"."ai_key" CASCADE;--> statement-breakpoint
DROP TABLE "app"."ai_key" CASCADE;--> statement-breakpoint
ALTER TABLE "app"."message" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "app"."message" ADD COLUMN "reasoning" text;--> statement-breakpoint
ALTER TABLE "app"."run" ADD COLUMN "provider" text DEFAULT 'opendash' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."run" ADD COLUMN "reasoning" text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."eval_run" ADD COLUMN "provider" text DEFAULT 'opendash' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."eval_run" ADD COLUMN "reasoning" text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."ai_settings" ADD COLUMN "default_provider" text DEFAULT 'opendash' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."ai_settings" ADD COLUMN "default_reasoning" text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."ai_provider" ADD CONSTRAINT "ai_provider_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."ai_provider" ADD CONSTRAINT "ai_provider_org_id_secret_id_secret_org_id_id_fk" FOREIGN KEY ("org_id","secret_id") REFERENCES "app"."secret"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_provider_kind_uq" ON "app"."ai_provider" USING btree ("org_id","kind");--> statement-breakpoint
-- The models a workspace offered were OpenDash's (the deployment's keys): they become its OpenDash provider's ticked
-- models. The id is a uuidv7 (48-bit unix milliseconds, version 7) made here, as the app makes them.
INSERT INTO app.ai_provider (org_id, id, kind, status, picked)
SELECT org_id,
  encode(set_bit(set_bit(overlay(uuid_send(gen_random_uuid())
    placing substring(int8send(floor(extract(epoch from clock_timestamp()) * 1000)::bigint) from 3) from 1 for 6),
    52, 1), 53, 1), 'hex')::uuid,
  'opendash', 'ok', offered
FROM app.ai_settings;--> statement-breakpoint
ALTER TABLE "app"."ai_settings" DROP COLUMN "offered";--> statement-breakpoint
ALTER TABLE "app"."run" ADD CONSTRAINT "run_provider_check" CHECK ("app"."run"."provider" in ('opendash', 'gateway', 'openrouter', 'anthropic', 'openai', 'google', 'bedrock', 'vertex'));--> statement-breakpoint
ALTER TABLE "app"."run" ADD CONSTRAINT "run_reasoning_check" CHECK ("app"."run"."reasoning" in ('auto', 'quick', 'deep', 'max'));--> statement-breakpoint
ALTER TABLE "app"."ai_settings" ADD CONSTRAINT "ai_settings_provider_check" CHECK ("app"."ai_settings"."default_provider" in ('opendash', 'gateway', 'openrouter', 'anthropic', 'openai', 'google', 'bedrock', 'vertex'));--> statement-breakpoint
ALTER TABLE "app"."ai_settings" ADD CONSTRAINT "ai_settings_reasoning_check" CHECK ("app"."ai_settings"."default_reasoning" in ('auto', 'quick', 'deep', 'max'));--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."ai_provider" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."ai_provider" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);
CREATE TABLE "app"."ops_alert" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid,
	"kind" text NOT NULL,
	"subject" text NOT NULL,
	"message" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "ops_alert_kind_check" CHECK ("app"."ops_alert"."kind" in ('stuck_run', 'lost_job', 'dead_letter', 'partitions_missing'))
);
--> statement-breakpoint
ALTER TABLE "app"."ops_alert" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."ops_tick" (
	"name" text PRIMARY KEY NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"result" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."ops_tick" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."usage_daily" (
	"org_id" uuid NOT NULL,
	"day" date NOT NULL,
	"kind" text NOT NULL,
	"model" text NOT NULL,
	"key_source" text NOT NULL,
	"events" integer NOT NULL,
	"qty" bigint NOT NULL,
	"cost_usd" numeric(14, 6) NOT NULL,
	"unpriced" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_daily_org_id_day_kind_model_key_source_pk" PRIMARY KEY("org_id","day","kind","model","key_source")
);
--> statement-breakpoint
ALTER TABLE "app"."usage_daily" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."ops_alert" ADD CONSTRAINT "ops_alert_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."usage_daily" ADD CONSTRAINT "usage_daily_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ops_alert_open_uq" ON "app"."ops_alert" USING btree (coalesce("org_id", '00000000-0000-0000-0000-000000000000'::uuid),"kind","subject") WHERE "app"."ops_alert"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "ops_alert_org_idx" ON "app"."ops_alert" USING btree ("org_id","last_seen_at");--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."ops_alert" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."ops_alert" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "system" ON "app"."ops_tick" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."usage_daily" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."usage_daily" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);--> statement-breakpoint
-- When a named dispatcher last ran: all the web app's health check may know of the system's table.
create or replace function app.last_tick(tick_name text) returns timestamptz
  language sql stable security definer
  set search_path = app, pg_temp
  as $$ select at from app.ops_tick where name = tick_name $$;
--> statement-breakpoint
revoke all on function app.last_tick(text) from public;
--> statement-breakpoint
grant execute on function app.last_tick(text) to opendash_app, opendash_system;

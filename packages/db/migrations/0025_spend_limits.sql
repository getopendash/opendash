CREATE TABLE "app"."spend_limit" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"monthly_usd" numeric(12, 2),
	"daily_usd" numeric(12, 2),
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spend_limit_monthly_check" CHECK ("app"."spend_limit"."monthly_usd" is null or "app"."spend_limit"."monthly_usd" > 0),
	CONSTRAINT "spend_limit_daily_check" CHECK ("app"."spend_limit"."daily_usd" is null or "app"."spend_limit"."daily_usd" > 0)
);
--> statement-breakpoint
ALTER TABLE "app"."spend_limit" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."ops_alert" DROP CONSTRAINT "ops_alert_kind_check";--> statement-breakpoint
ALTER TABLE "app"."spend_limit" ADD CONSTRAINT "spend_limit_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."ops_alert" ADD CONSTRAINT "ops_alert_kind_check" CHECK ("app"."ops_alert"."kind" in ('stuck_run', 'lost_job', 'dead_letter', 'partitions_missing', 'spend'));--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."spend_limit" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."spend_limit" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);
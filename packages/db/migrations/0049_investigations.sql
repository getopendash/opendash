CREATE TABLE "app"."investigation" (
	"org_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"insight_id" uuid NOT NULL,
	"run_id" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"held_reason" text,
	"requested_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "investigation_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "investigation_status_check" CHECK ("app"."investigation"."status" in ('queued', 'running', 'confirmed', 'not_confirmed', 'failed', 'held'))
);
--> statement-breakpoint
ALTER TABLE "app"."investigation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."run" DROP CONSTRAINT "run_trigger_check";--> statement-breakpoint
ALTER TABLE "app"."run" DROP CONSTRAINT "run_profile_check";--> statement-breakpoint
ALTER TABLE "app"."thread" DROP CONSTRAINT "thread_channel_check";--> statement-breakpoint
ALTER TABLE "app"."insight" DROP CONSTRAINT "insight_dismiss_check";--> statement-breakpoint
ALTER TABLE "app"."investigation" ADD CONSTRAINT "investigation_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."investigation" ADD CONSTRAINT "investigation_org_id_insight_id_insight_org_id_id_fk" FOREIGN KEY ("org_id","insight_id") REFERENCES "app"."insight"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "investigation_insight_uq" ON "app"."investigation" USING btree ("org_id","insight_id");--> statement-breakpoint
ALTER TABLE "app"."run" ADD CONSTRAINT "run_trigger_check" CHECK ("app"."run"."trigger" in ('user', 'api', 'eval', 'slack', 'insight'));--> statement-breakpoint
ALTER TABLE "app"."run" ADD CONSTRAINT "run_profile_check" CHECK ("app"."run"."profile" in ('analyst', 'investigator'));--> statement-breakpoint
ALTER TABLE "app"."thread" ADD CONSTRAINT "thread_channel_check" CHECK ("app"."thread"."channel" in ('web', 'api', 'eval', 'slack', 'insight'));--> statement-breakpoint
ALTER TABLE "app"."insight" ADD CONSTRAINT "insight_dismiss_check" CHECK ("app"."insight"."dismiss_reason" is null or "app"."insight"."dismiss_reason" in ('not_a_problem', 'known_issue', 'wrong_data', 'not_my_area', 'not_confirmed'));--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."investigation" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."investigation" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);
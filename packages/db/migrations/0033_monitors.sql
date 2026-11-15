CREATE TABLE "app"."insight" (
	"org_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"metric_id" uuid,
	"direction" text,
	"period" date NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"severity" smallint NOT NULL,
	"score" double precision,
	"dedupe_key" text NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"dismiss_reason" text,
	"status_by" uuid,
	"status_at" timestamp with time zone,
	"claims" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"query_run_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"occurrences" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "insight_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "insight_kind_check" CHECK ("app"."insight"."kind" in ('anomaly', 'trend', 'threshold', 'goal_risk', 'data_quality')),
	CONSTRAINT "insight_status_check" CHECK ("app"."insight"."status" in ('new', 'seen', 'dismissed', 'resolved')),
	CONSTRAINT "insight_dismiss_check" CHECK ("app"."insight"."dismiss_reason" is null or "app"."insight"."dismiss_reason" in ('not_a_problem', 'known_issue', 'wrong_data', 'not_my_area'))
);
--> statement-breakpoint
ALTER TABLE "app"."insight" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."insight" ADD CONSTRAINT "insight_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "insight_open_uq" ON "app"."insight" USING btree ("org_id","dedupe_key") WHERE "app"."insight"."status" in ('new', 'seen');--> statement-breakpoint
CREATE INDEX "insight_feed_idx" ON "app"."insight" USING btree ("org_id","status","last_seen_at" DESC NULLS LAST);--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."insight" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."insight" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);
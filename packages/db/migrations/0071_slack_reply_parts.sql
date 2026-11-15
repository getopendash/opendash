-- Every reply in Slack posted once: each attempt fenced by its number, each part of the reply recorded
-- before it's posted and after, so a resumed attempt posts only what isn't there (looking in the thread, by the
-- metadata each part carries, for one it may have posted just before it stopped).
CREATE TABLE "app"."slack_reply_message" (
	"org_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"part" text NOT NULL,
	"status" text DEFAULT 'posting' NOT NULL,
	"ts" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"posted_at" timestamp with time zone,
	CONSTRAINT "slack_reply_message_org_id_run_id_part_pk" PRIMARY KEY("org_id","run_id","part"),
	CONSTRAINT "slack_reply_message_status_check" CHECK ("app"."slack_reply_message"."status" in ('posting', 'posted'))
);
--> statement-breakpoint
ALTER TABLE "app"."slack_reply_message" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."slack_reply" ADD COLUMN "attempt" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."slack_reply" ADD COLUMN "failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."slack_reply" ADD COLUMN "error" text;--> statement-breakpoint
ALTER TABLE "app"."slack_reply_message" ADD CONSTRAINT "slack_reply_message_org_id_run_id_slack_reply_org_id_run_id_fk" FOREIGN KEY ("org_id","run_id") REFERENCES "app"."slack_reply"("org_id","run_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."slack_reply_message" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."slack_reply_message" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);
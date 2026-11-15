-- Every question from Slack recorded before Slack hears it arrived: a message to the bot or a press of
-- its buttons, keyed by Slack's ids, so a retried or twin delivery is one row; one never handled is handed to the bot
-- again, and after three tries the person is told. What Slack sent is kept only until handled; rows go after a week.
CREATE TABLE "app"."slack_inbound" (
	"org_id" uuid NOT NULL,
	"team_id" text NOT NULL,
	"key" text NOT NULL,
	"kind" text NOT NULL,
	"slack_thread_id" text NOT NULL,
	"slack_user_id" text NOT NULL,
	"envelope" jsonb,
	"status" text DEFAULT 'received' NOT NULL,
	"replays" integer DEFAULT 0 NOT NULL,
	"next_at" timestamp with time zone NOT NULL,
	"run_id" uuid,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"handled_at" timestamp with time zone,
	CONSTRAINT "slack_inbound_org_id_team_id_key_pk" PRIMARY KEY("org_id","team_id","key"),
	CONSTRAINT "slack_inbound_kind_check" CHECK ("app"."slack_inbound"."kind" in ('message', 'press')),
	CONSTRAINT "slack_inbound_status_check" CHECK ("app"."slack_inbound"."status" in ('received', 'handled', 'asked', 'lost'))
);
--> statement-breakpoint
ALTER TABLE "app"."slack_inbound" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."slack_inbound" ADD CONSTRAINT "slack_inbound_org_id_team_id_slack_workspace_org_id_team_id_fk" FOREIGN KEY ("org_id","team_id") REFERENCES "app"."slack_workspace"("org_id","team_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "slack_inbound_due_idx" ON "app"."slack_inbound" USING btree ("next_at") WHERE "app"."slack_inbound"."status" = 'received';--> statement-breakpoint
CREATE INDEX "slack_inbound_received_idx" ON "app"."slack_inbound" USING btree ("received_at");--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."slack_inbound" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."slack_inbound" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);
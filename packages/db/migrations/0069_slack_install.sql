-- Add to Slack on its way: held when Slack comes back to OpenDash's public address (a tunnel locally),
-- connected only when the person who started it confirms it in the same browser. Ten minutes; purged with its token.
CREATE TABLE "app"."slack_install" (
	"org_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"browser_hash" text NOT NULL,
	"status" text DEFAULT 'started' NOT NULL,
	"confirm_hash" text,
	"secret_id" uuid,
	"team" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "slack_install_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "slack_install_status_check" CHECK ("app"."slack_install"."status" in ('started', 'returned'))
);
--> statement-breakpoint
ALTER TABLE "app"."slack_install" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."slack_install" ADD CONSTRAINT "slack_install_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."slack_install" ADD CONSTRAINT "slack_install_org_id_secret_id_secret_org_id_id_fk" FOREIGN KEY ("org_id","secret_id") REFERENCES "app"."secret"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."slack_install" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."slack_install" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);
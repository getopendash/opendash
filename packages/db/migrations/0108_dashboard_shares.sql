CREATE TABLE "app"."dashboard_share" (
	"org_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"dashboard_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"added_by" uuid NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dashboard_share_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "dashboard_share_role_check" CHECK ("app"."dashboard_share"."role" in ('view', 'edit'))
);
--> statement-breakpoint
ALTER TABLE "app"."dashboard_share" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."dashboard_share" ADD CONSTRAINT "dashboard_share_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."dashboard_share" ADD CONSTRAINT "dashboard_share_org_id_dashboard_id_dashboard_org_id_id_fk" FOREIGN KEY ("org_id","dashboard_id") REFERENCES "app"."dashboard"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dashboard_share_person_uq" ON "app"."dashboard_share" USING btree ("org_id","dashboard_id","user_id");--> statement-breakpoint
CREATE INDEX "dashboard_share_user_idx" ON "app"."dashboard_share" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."dashboard_share" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."dashboard_share" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);
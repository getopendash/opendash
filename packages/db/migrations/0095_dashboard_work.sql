CREATE TABLE "app"."dashboard_work" (
	"org_id" uuid NOT NULL,
	"dashboard_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"dataset" text NOT NULL,
	"record_key" text NOT NULL,
	"owner_id" uuid,
	"status" text,
	"note" text,
	"follow_up" date,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dashboard_work_org_id_dashboard_id_connection_id_dataset_record_key_pk" PRIMARY KEY("org_id","dashboard_id","connection_id","dataset","record_key"),
	CONSTRAINT "dashboard_work_note_check" CHECK (char_length("app"."dashboard_work"."note") <= 2000)
);
--> statement-breakpoint
ALTER TABLE "app"."dashboard_work" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."dashboard_work" ADD CONSTRAINT "dashboard_work_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."dashboard_work" ADD CONSTRAINT "dashboard_work_org_id_dashboard_id_dashboard_org_id_id_fk" FOREIGN KEY ("org_id","dashboard_id") REFERENCES "app"."dashboard"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dashboard_work_owner_idx" ON "app"."dashboard_work" USING btree ("org_id","owner_id");--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."dashboard_work" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."dashboard_work" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);
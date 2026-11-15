CREATE TABLE "app"."dashboard_input" (
	"org_id" uuid NOT NULL,
	"dashboard_id" uuid NOT NULL,
	"input" text NOT NULL,
	"value" double precision NOT NULL,
	"set_by" uuid NOT NULL,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dashboard_input_org_id_dashboard_id_input_pk" PRIMARY KEY("org_id","dashboard_id","input")
);
--> statement-breakpoint
ALTER TABLE "app"."dashboard_input" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."dashboard_work_event" (
	"org_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"dashboard_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"dataset" text NOT NULL,
	"record_key" text NOT NULL,
	"field" text NOT NULL,
	"value" text,
	"by" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dashboard_work_event_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "dashboard_work_event_field_check" CHECK ("app"."dashboard_work_event"."field" in ('owner', 'status', 'note', 'follow_up')),
	CONSTRAINT "dashboard_work_event_value_check" CHECK (char_length("app"."dashboard_work_event"."value") <= 2000)
);
--> statement-breakpoint
ALTER TABLE "app"."dashboard_work_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."dashboard_input" ADD CONSTRAINT "dashboard_input_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."dashboard_input" ADD CONSTRAINT "dashboard_input_org_id_dashboard_id_dashboard_org_id_id_fk" FOREIGN KEY ("org_id","dashboard_id") REFERENCES "app"."dashboard"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."dashboard_work_event" ADD CONSTRAINT "dashboard_work_event_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."dashboard_work_event" ADD CONSTRAINT "dashboard_work_event_org_id_dashboard_id_dashboard_org_id_id_fk" FOREIGN KEY ("org_id","dashboard_id") REFERENCES "app"."dashboard"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dashboard_work_event_record_idx" ON "app"."dashboard_work_event" USING btree ("org_id","dashboard_id","connection_id","dataset","record_key","at");--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."dashboard_input" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."dashboard_input" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."dashboard_work_event" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."dashboard_work_event" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);
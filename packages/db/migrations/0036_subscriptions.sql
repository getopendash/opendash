CREATE TABLE "app"."artifact_snapshot" (
	"org_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"artifact_id" uuid NOT NULL,
	"artifact_version" integer NOT NULL,
	"reason" text NOT NULL,
	"bound" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"query_run_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"claims" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"verification" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"render_key" text,
	"stale_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifact_snapshot_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "artifact_snapshot_reason_check" CHECK ("app"."artifact_snapshot"."reason" in ('publish', 'schedule', 'export', 'share', 'verify'))
);
--> statement-breakpoint
ALTER TABLE "app"."artifact_snapshot" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."artifact_snapshot" ADD CONSTRAINT "artifact_snapshot_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifact_snapshot_artifact_idx" ON "app"."artifact_snapshot" USING btree ("org_id","artifact_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."artifact_snapshot" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."artifact_snapshot" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);

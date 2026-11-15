CREATE TABLE "app"."catalog_object" (
	"org_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"parent_id" uuid,
	"kind" text NOT NULL,
	"fq_name" text NOT NULL,
	"name" text NOT NULL,
	"data_type" text,
	"nullable" boolean,
	"comment" text,
	"profile" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sensitivity" text DEFAULT 'none' NOT NULL,
	"sensitivity_set_by" uuid,
	"usage_score" real DEFAULT 0 NOT NULL,
	"first_seen_snapshot" uuid,
	"last_seen_snapshot" uuid,
	"removed_at" timestamp with time zone,
	"values_state" text DEFAULT 'none' NOT NULL,
	"values_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_object_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "catalog_object_kind_check" CHECK ("app"."catalog_object"."kind" in ('schema', 'table', 'view', 'column')),
	CONSTRAINT "catalog_object_sensitivity_check" CHECK ("app"."catalog_object"."sensitivity" in ('none', 'pii', 'secret')),
	CONSTRAINT "catalog_object_values_state_check" CHECK ("app"."catalog_object"."values_state" in ('none', 'indexed', 'excluded'))
);
--> statement-breakpoint
ALTER TABLE "app"."catalog_object" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."column_value" (
	"org_id" uuid NOT NULL,
	"column_id" uuid NOT NULL,
	"value_hash" text NOT NULL,
	"value" text NOT NULL,
	"value_norm" text NOT NULL,
	"freq" integer NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "column_value_org_id_column_id_value_hash_pk" PRIMARY KEY("org_id","column_id","value_hash")
);
--> statement-breakpoint
ALTER TABLE "app"."column_value" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."schema_snapshot" (
	"org_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"sync_run_id" uuid,
	"content_hash" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"diff" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schema_snapshot_org_id_id_pk" PRIMARY KEY("org_id","id")
);
--> statement-breakpoint
ALTER TABLE "app"."schema_snapshot" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."sync_run" (
	"org_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"facts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"message" text,
	"requested_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "sync_run_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "sync_run_status_check" CHECK ("app"."sync_run"."status" in ('queued', 'running', 'succeeded', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "app"."sync_run" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."catalog_object" ADD CONSTRAINT "catalog_object_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."catalog_object" ADD CONSTRAINT "catalog_object_org_id_connection_id_connection_org_id_id_fk" FOREIGN KEY ("org_id","connection_id") REFERENCES "app"."connection"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."catalog_object" ADD CONSTRAINT "catalog_object_org_id_parent_id_catalog_object_org_id_id_fk" FOREIGN KEY ("org_id","parent_id") REFERENCES "app"."catalog_object"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."column_value" ADD CONSTRAINT "column_value_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."column_value" ADD CONSTRAINT "column_value_org_id_column_id_catalog_object_org_id_id_fk" FOREIGN KEY ("org_id","column_id") REFERENCES "app"."catalog_object"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."schema_snapshot" ADD CONSTRAINT "schema_snapshot_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."schema_snapshot" ADD CONSTRAINT "schema_snapshot_org_id_connection_id_connection_org_id_id_fk" FOREIGN KEY ("org_id","connection_id") REFERENCES "app"."connection"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sync_run" ADD CONSTRAINT "sync_run_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sync_run" ADD CONSTRAINT "sync_run_org_id_connection_id_connection_org_id_id_fk" FOREIGN KEY ("org_id","connection_id") REFERENCES "app"."connection"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_object_fq_name_uq" ON "app"."catalog_object" USING btree ("org_id","connection_id","fq_name");--> statement-breakpoint
CREATE INDEX "catalog_object_parent_idx" ON "app"."catalog_object" USING btree ("org_id","parent_id");--> statement-breakpoint
CREATE INDEX "column_value_norm_trgm_idx" ON "app"."column_value" USING gin ("org_id","value_norm" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "schema_snapshot_connection_idx" ON "app"."schema_snapshot" USING btree ("org_id","connection_id","id");--> statement-breakpoint
CREATE INDEX "sync_run_connection_idx" ON "app"."sync_run" USING btree ("org_id","connection_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sync_run_active_uq" ON "app"."sync_run" USING btree ("org_id","connection_id") WHERE "app"."sync_run"."status" in ('queued', 'running');--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."catalog_object" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."catalog_object" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."column_value" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."column_value" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."schema_snapshot" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."schema_snapshot" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."sync_run" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."sync_run" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);
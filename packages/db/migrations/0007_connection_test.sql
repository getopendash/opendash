CREATE TABLE "app"."connection_test" (
	"org_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"dialect" text NOT NULL,
	"config" jsonb NOT NULL,
	"secret_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"checks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"facts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"message" text,
	"requested_by" uuid,
	"connection_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "connection_test_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "connection_test_dialect_check" CHECK ("app"."connection_test"."dialect" in ('postgres', 'mysql', 'clickhouse', 'snowflake', 'bigquery', 'databricks', 'redshift', 'mssql', 'duckdb', 'motherduck', 'trino', 'lake')),
	CONSTRAINT "connection_test_status_check" CHECK ("app"."connection_test"."status" in ('queued', 'running', 'passed', 'warning', 'blocked', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "app"."connection_test" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."connection" ADD COLUMN "write_access_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."connection" ADD COLUMN "write_access_accepted_by" uuid;--> statement-breakpoint
ALTER TABLE "app"."connection_test" ADD CONSTRAINT "connection_test_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."connection_test" ADD CONSTRAINT "connection_test_org_id_secret_id_secret_org_id_id_fk" FOREIGN KEY ("org_id","secret_id") REFERENCES "app"."secret"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."connection_test" ADD CONSTRAINT "connection_test_org_id_connection_id_connection_org_id_id_fk" FOREIGN KEY ("org_id","connection_id") REFERENCES "app"."connection"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "connection_test_connection_uq" ON "app"."connection_test" USING btree ("org_id","connection_id");--> statement-breakpoint
CREATE INDEX "connection_test_created_idx" ON "app"."connection_test" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."connection_test" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."connection_test" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);
CREATE TABLE "app"."connection" (
	"org_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"name" text NOT NULL,
	"dialect" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secret_id" uuid,
	"network" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"limits" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"read_only_verified_at" timestamp with time zone,
	"allow_edits" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'ok' NOT NULL,
	"last_error" text,
	"sync_rrule" text,
	"next_sync_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "connection_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "connection_dialect_check" CHECK ("app"."connection"."dialect" in ('postgres', 'mysql', 'clickhouse', 'snowflake', 'bigquery', 'databricks', 'redshift', 'mssql', 'duckdb', 'motherduck', 'trino', 'lake')),
	CONSTRAINT "connection_status_check" CHECK ("app"."connection"."status" in ('ok', 'error', 'disabled'))
);
--> statement-breakpoint
ALTER TABLE "app"."connection" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."secret" (
	"org_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"kind" text NOT NULL,
	"key_version" smallint NOT NULL,
	"nonce" "bytea" NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone,
	CONSTRAINT "secret_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "secret_kind_check" CHECK ("app"."secret"."kind" in ('connection', 'oauth', 'llm_key', 'webhook', 'ssh', 'mcp'))
);
--> statement-breakpoint
ALTER TABLE "app"."secret" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."connection" ADD CONSTRAINT "connection_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."connection" ADD CONSTRAINT "connection_org_id_secret_id_secret_org_id_id_fk" FOREIGN KEY ("org_id","secret_id") REFERENCES "app"."secret"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."secret" ADD CONSTRAINT "secret_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "connection_org_name_uq" ON "app"."connection" USING btree ("org_id",lower("name")) WHERE "app"."connection"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "connection_next_sync_idx" ON "app"."connection" USING btree ("next_sync_at") WHERE "app"."connection"."deleted_at" is null;--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."connection" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."connection" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."secret" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."secret" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);
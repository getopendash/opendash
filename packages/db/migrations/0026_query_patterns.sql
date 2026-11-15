CREATE TABLE "app"."query_pattern" (
	"org_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"sql" text NOT NULL,
	"calls" bigint NOT NULL,
	"total_ms" bigint NOT NULL,
	"tables" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"mined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "query_pattern_org_id_connection_id_fingerprint_pk" PRIMARY KEY("org_id","connection_id","fingerprint")
);
--> statement-breakpoint
ALTER TABLE "app"."query_pattern" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."query_pattern" ADD CONSTRAINT "query_pattern_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."query_pattern" ADD CONSTRAINT "query_pattern_org_id_connection_id_connection_org_id_id_fk" FOREIGN KEY ("org_id","connection_id") REFERENCES "app"."connection"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "query_pattern_tables_idx" ON "app"."query_pattern" USING gin ("tables");--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."query_pattern" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."query_pattern" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);
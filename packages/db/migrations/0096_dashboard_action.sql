CREATE TABLE "app"."dashboard_action" (
	"org_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"dashboard_id" uuid NOT NULL,
	"revision" text NOT NULL,
	"section" text NOT NULL,
	"action" text NOT NULL,
	"user_id" uuid NOT NULL,
	"record_key" text NOT NULL,
	"server_id" uuid NOT NULL,
	"tool" text NOT NULL,
	"arguments" jsonb NOT NULL,
	"arguments_hash" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"account_revision" integer NOT NULL,
	"tool_digest" text NOT NULL,
	"status" text DEFAULT 'prepared' NOT NULL,
	"result" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ran_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	CONSTRAINT "dashboard_action_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "dashboard_action_status_check" CHECK ("app"."dashboard_action"."status" in ('prepared', 'running', 'done', 'failed', 'unknown')),
	CONSTRAINT "dashboard_action_result_check" CHECK (char_length("app"."dashboard_action"."result") <= 300)
);
--> statement-breakpoint
ALTER TABLE "app"."dashboard_action" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."dashboard_action" ADD CONSTRAINT "dashboard_action_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."dashboard_action" ADD CONSTRAINT "dashboard_action_org_id_dashboard_id_dashboard_org_id_id_fk" FOREIGN KEY ("org_id","dashboard_id") REFERENCES "app"."dashboard"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dashboard_action_user_idx" ON "app"."dashboard_action" USING btree ("org_id","user_id","created_at");--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."dashboard_action" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."dashboard_action" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);--> statement-breakpoint
-- A service's read is a query_run too: path and engine mcp.
ALTER TABLE "app"."query_run" DROP CONSTRAINT "query_run_path_check";--> statement-breakpoint
ALTER TABLE "app"."query_run" ADD CONSTRAINT "query_run_path_check" CHECK (path in ('verified_query', 'metric', 'model_sql', 'raw_sql', 'compute', 'mcp'));--> statement-breakpoint
ALTER TABLE "app"."query_run" DROP CONSTRAINT "query_run_engine_check";--> statement-breakpoint
ALTER TABLE "app"."query_run" ADD CONSTRAINT "query_run_engine_check" CHECK (engine in ('compiler', 'agent_sql', 'duckdb', 'mcp'));

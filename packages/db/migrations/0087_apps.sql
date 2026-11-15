CREATE TABLE "app"."app_build" (
	"org_id" uuid NOT NULL,
	"artifact_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"connection_id" uuid NOT NULL,
	"files" jsonb NOT NULL,
	"manifest" jsonb NOT NULL,
	"bundle" text NOT NULL,
	"bundle_hash" text NOT NULL,
	"report" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_build_org_id_artifact_id_version_pk" PRIMARY KEY("org_id","artifact_id","version"),
	CONSTRAINT "app_build_hash_check" CHECK ("app"."app_build"."bundle_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "app"."app_build" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."app_draft" (
	"org_id" uuid NOT NULL,
	"artifact_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"files" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"manifest" jsonb NOT NULL,
	"base_version" integer,
	"run_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_draft_org_id_artifact_id_pk" PRIMARY KEY("org_id","artifact_id")
);
--> statement-breakpoint
ALTER TABLE "app"."app_draft" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."app_result" (
	"org_id" uuid NOT NULL,
	"cache_key" text NOT NULL,
	"artifact_id" uuid NOT NULL,
	"status" text NOT NULL,
	"result" jsonb,
	"error" text,
	"query_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "app_result_org_id_cache_key_pk" PRIMARY KEY("org_id","cache_key"),
	CONSTRAINT "app_result_status_check" CHECK ("app"."app_result"."status" in ('ok', 'failed')),
	CONSTRAINT "app_result_shape_check" CHECK (("app"."app_result"."status" = 'ok') = ("app"."app_result"."result" is not null))
);
--> statement-breakpoint
ALTER TABLE "app"."app_result" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."run" DROP CONSTRAINT "run_profile_check";--> statement-breakpoint
ALTER TABLE "app"."thread" DROP CONSTRAINT "thread_channel_check";--> statement-breakpoint
ALTER TABLE "app"."artifact" DROP CONSTRAINT "artifact_kind_check";--> statement-breakpoint
ALTER TABLE "app"."app_build" ADD CONSTRAINT "app_build_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."app_build" ADD CONSTRAINT "app_build_org_id_artifact_id_version_artifact_version_org_id_artifact_id_version_fk" FOREIGN KEY ("org_id","artifact_id","version") REFERENCES "app"."artifact_version"("org_id","artifact_id","version") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."app_build" ADD CONSTRAINT "app_build_org_id_connection_id_connection_org_id_id_fk" FOREIGN KEY ("org_id","connection_id") REFERENCES "app"."connection"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."app_draft" ADD CONSTRAINT "app_draft_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."app_draft" ADD CONSTRAINT "app_draft_org_id_artifact_id_artifact_org_id_id_fk" FOREIGN KEY ("org_id","artifact_id") REFERENCES "app"."artifact"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."app_draft" ADD CONSTRAINT "app_draft_org_id_connection_id_connection_org_id_id_fk" FOREIGN KEY ("org_id","connection_id") REFERENCES "app"."connection"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."app_result" ADD CONSTRAINT "app_result_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."app_result" ADD CONSTRAINT "app_result_org_id_artifact_id_artifact_org_id_id_fk" FOREIGN KEY ("org_id","artifact_id") REFERENCES "app"."artifact"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_build_bundle_idx" ON "app"."app_build" USING btree ("bundle_hash");--> statement-breakpoint
CREATE INDEX "app_result_expires_idx" ON "app"."app_result" USING btree ("org_id","expires_at");--> statement-breakpoint
ALTER TABLE "app"."run" ADD CONSTRAINT "run_profile_check" CHECK ("app"."run"."profile" in ('analyst', 'investigator', 'reviewer', 'modeler', 'drafter', 'curator', 'composer', 'builder'));--> statement-breakpoint
ALTER TABLE "app"."thread" ADD CONSTRAINT "thread_channel_check" CHECK ("app"."thread"."channel" in ('web', 'api', 'eval', 'slack', 'insight', 'routine', 'modeler', 'curator', 'app'));--> statement-breakpoint
ALTER TABLE "app"."artifact" ADD CONSTRAINT "artifact_kind_check" CHECK ("app"."artifact"."kind" in ('report', 'dashboard', 'deck', 'kpi_card', 'chart', 'table', 'page', 'app'));--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."app_build" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."app_build" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."app_draft" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."app_draft" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."app_result" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."app_result" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);--> statement-breakpoint
-- An App's bundle by its hash, for the Apps origin, which serves frames without a session (and so with no tenant):
-- the bundle of a version of an App that isn't deleted, or nothing. A bundle is the App's code, never its data, and
-- its hash is only in the frame document a signed link opens.
create function app.app_bundle(p_hash text) returns text
  language sql stable security definer
  set search_path = pg_catalog, pg_temp
  as $$
    select b.bundle from app.app_build b
    join app.artifact a on a.org_id = b.org_id and a.id = b.artifact_id
    where b.bundle_hash = p_hash and a.deleted_at is null and a.kind = 'app'
    limit 1
  $$;
--> statement-breakpoint
revoke all on function app.app_bundle(text) from public;
--> statement-breakpoint
grant execute on function app.app_bundle(text) to opendash_app;

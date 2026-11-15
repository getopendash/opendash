CREATE TABLE "app"."artifact" (
	"org_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"project_id" uuid,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"owner_id" uuid,
	"visibility" text DEFAULT 'private' NOT NULL,
	"current_version" integer NOT NULL,
	"published_version" integer,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"origin_thread_id" uuid,
	"verification_status" text DEFAULT 'unverified' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "artifact_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "artifact_kind_check" CHECK ("app"."artifact"."kind" in ('report', 'dashboard', 'deck', 'kpi_card', 'chart', 'table', 'page')),
	CONSTRAINT "artifact_visibility_check" CHECK ("app"."artifact"."visibility" in ('private', 'project', 'org')),
	CONSTRAINT "artifact_verification_check" CHECK ("app"."artifact"."verification_status" in ('unverified', 'in_progress', 'verified', 'stale', 'failed', 'error'))
);
--> statement-breakpoint
ALTER TABLE "app"."artifact" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."artifact_version" (
	"org_id" uuid NOT NULL,
	"artifact_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"doc" text NOT NULL,
	"state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"library_spec_version" text NOT NULL,
	"bindings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"decision_id" uuid,
	"context_release_id" uuid,
	"author_type" text NOT NULL,
	"author_id" uuid,
	"run_id" uuid,
	"parent_version" integer,
	"change_note" text,
	"validation" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifact_version_org_id_artifact_id_version_pk" PRIMARY KEY("org_id","artifact_id","version"),
	CONSTRAINT "artifact_version_author_check" CHECK ("app"."artifact_version"."author_type" in ('user', 'agent'))
);
--> statement-breakpoint
ALTER TABLE "app"."artifact_version" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."artifact" ADD CONSTRAINT "artifact_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."artifact_version" ADD CONSTRAINT "artifact_version_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."artifact_version" ADD CONSTRAINT "artifact_version_org_id_artifact_id_artifact_org_id_id_fk" FOREIGN KEY ("org_id","artifact_id") REFERENCES "app"."artifact"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifact_updated_idx" ON "app"."artifact" USING btree ("org_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "artifact_owner_idx" ON "app"."artifact" USING btree ("org_id","owner_id");--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."artifact" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."artifact" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."artifact_version" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."artifact_version" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);--> statement-breakpoint
-- An artifact version is never changed: an edit, a restore or a check's new result is a new version.
create or replace function app.artifact_version_immutable() returns trigger
  language plpgsql as $$
begin
  raise exception 'an artifact_version is never changed: write a new version';
end
$$;
--> statement-breakpoint
create trigger artifact_version_immutable before update on app.artifact_version
  for each row execute function app.artifact_version_immutable();
--> statement-breakpoint
-- The result cache: a run that may be reused within its freshness bucket carries its key. There is no
-- cache table; this partial index is the cache. Failed runs keep their key too, so a broken tile isn't re-queried on
-- every look until its bucket ends.
alter table app.query_run add column cache_key text;
--> statement-breakpoint
create index query_run_cache_idx on app.query_run (org_id, cache_key, id desc) where cache_key is not null;

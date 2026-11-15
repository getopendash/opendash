-- Dashboards replace the old dashboards, reports, public links and Apps (retired completely, nothing kept for
-- compatibility). What used them goes with them, before the checks that no longer allow it.
-- Routines that sent a dashboard or its written summary go, with their runs (cascade) and their sends. A run made while
-- its routine sent a dashboard goes too, whatever its routine does now. A scheduled question's run still sending its
-- answer as a report fails, saying why, so it settles (its sends go with the reports); the next one goes as an answer.
delete from app.routine_run where spec_snapshot->'action'->>'kind' = 'send_dashboard';--> statement-breakpoint
update app.routine_run rr set status = 'failed', error = 'Reports were retired before it went out. The next one goes.',
    updated_at = now()
  where rr.status in ('queued', 'running', 'writing', 'waiting', 'sending')
    and exists (select 1 from app.effect e
      where e.org_id = rr.org_id and e.source_type = 'routine_run' and e.source_id = rr.id
        and e.payload->>'kind' in ('dashboard', 'edition'));--> statement-breakpoint
delete from app.effect where payload->>'kind' in ('dashboard', 'edition');--> statement-breakpoint
delete from app.routine where spec->'action'->>'kind' = 'send_dashboard';--> statement-breakpoint
-- The Reviewer's and the App builder's conversations hold nothing else: each goes whole (runs, messages, tool calls),
-- with what their runs left outside them (feedback, query runs, events).
delete from app.feedback f using app.run r, app.thread t
  where f.org_id = r.org_id and f.target_type = 'run' and f.target_id = r.id
    and t.org_id = r.org_id and t.id = r.thread_id
    and (t.channel = 'app' or t.id in (select thread_id from app.run where profile in ('reviewer', 'builder')));--> statement-breakpoint
delete from app.query_run q using app.run r, app.thread t
  where q.org_id = r.org_id and q.requester_type = 'run' and q.requester_id = r.id
    and t.org_id = r.org_id and t.id = r.thread_id
    and (t.channel = 'app' or t.id in (select thread_id from app.run where profile in ('reviewer', 'builder')));--> statement-breakpoint
delete from app.run_event e using app.run r, app.thread t
  where e.org_id = r.org_id and e.run_id = r.id
    and t.org_id = r.org_id and t.id = r.thread_id
    and (t.channel = 'app' or t.id in (select thread_id from app.run where profile in ('reviewer', 'builder')));--> statement-breakpoint
delete from app.thread where channel = 'app'
  or id in (select thread_id from app.run where profile in ('reviewer', 'builder'));--> statement-breakpoint
-- An App plan the analyst wrote in an ordinary conversation: said as what it is now.
update app.run set outcome = jsonb_build_object('kind', 'no_answer', 'reason', 'This planned an App. Apps were replaced by dashboards.')
  where outcome->>'kind' in ('app_plan', 'app', 'review');--> statement-breakpoint
-- A question's attached dashboards and Apps: the question stays, the attachments go.
update app.message m set attachments = coalesce(
    (select jsonb_agg(a) from jsonb_array_elements(m.attachments) a where a->>'kind' not in ('dashboard', 'app')),
    '[]'::jsonb)
  where jsonb_typeof(m.attachments) = 'array'
    and exists (select 1 from jsonb_array_elements(m.attachments) a where a->>'kind' in ('dashboard', 'app'));--> statement-breakpoint
delete from app.user_mark where target_type = 'artifact';--> statement-breakpoint
delete from app.context_item where anchor_type = 'artifact';--> statement-breakpoint
delete from app.feedback where target_type = 'artifact_version';--> statement-breakpoint
update app.org set settings = settings - 'share_links' where settings ? 'share_links';--> statement-breakpoint
-- query_run is partitioned (0009, hand-written): the parent's check and columns reach every partition. A dashboard's
-- query runs are its own now; the old ones' results go with them.
delete from app.query_run where requester_type = 'artifact';--> statement-breakpoint
alter table app.query_run drop constraint query_run_requester_type_check;--> statement-breakpoint
alter table app.query_run add constraint query_run_requester_type_check
  check (requester_type in ('run', 'dashboard', 'check', 'eval', 'api', 'mcp', 'definition', 'task'));--> statement-breakpoint
alter table app.query_run drop column pinned_at;--> statement-breakpoint
drop function if exists app.resolve_share(text);--> statement-breakpoint
drop function if exists app.app_bundle(text);--> statement-breakpoint
CREATE TABLE "app"."dashboard" (
	"org_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"project_id" uuid,
	"folder_id" uuid,
	"title" text NOT NULL,
	"purpose" text,
	"owner_id" uuid NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"current_version" integer DEFAULT 0 NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"thread_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "dashboard_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "dashboard_visibility_check" CHECK ("app"."dashboard"."visibility" in ('private', 'project', 'org')),
	CONSTRAINT "dashboard_project_visibility_check" CHECK ("app"."dashboard"."visibility" <> 'project' or "app"."dashboard"."project_id" is not null),
	CONSTRAINT "dashboard_folder_project_check" CHECK ("app"."dashboard"."folder_id" is null or "app"."dashboard"."project_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "app"."dashboard" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."dashboard_draft" (
	"org_id" uuid NOT NULL,
	"dashboard_id" uuid NOT NULL,
	"definition" jsonb NOT NULL,
	"parts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"bundle" text,
	"bundle_hash" text,
	"runtime_hash" text,
	"revision" text,
	"base_version" integer DEFAULT 0 NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dashboard_draft_org_id_dashboard_id_pk" PRIMARY KEY("org_id","dashboard_id")
);
--> statement-breakpoint
ALTER TABLE "app"."dashboard_draft" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."dashboard_result" (
	"org_id" uuid NOT NULL,
	"cache_key" text NOT NULL,
	"status" text NOT NULL,
	"result" jsonb,
	"error" text,
	"query_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "dashboard_result_org_id_cache_key_pk" PRIMARY KEY("org_id","cache_key"),
	CONSTRAINT "dashboard_result_status_check" CHECK ("app"."dashboard_result"."status" in ('ok', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "app"."dashboard_result" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."dashboard_version" (
	"org_id" uuid NOT NULL,
	"dashboard_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"definition" jsonb NOT NULL,
	"parts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"bundle" text,
	"bundle_hash" text,
	"runtime_hash" text NOT NULL,
	"revision" text NOT NULL,
	"author_id" uuid,
	"run_id" uuid,
	"parent_version" integer,
	"change_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dashboard_version_org_id_dashboard_id_version_pk" PRIMARY KEY("org_id","dashboard_id","version")
);
--> statement-breakpoint
ALTER TABLE "app"."dashboard_version" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY "tenant" ON "app"."artifact" CASCADE;--> statement-breakpoint
DROP POLICY "system" ON "app"."artifact" CASCADE;--> statement-breakpoint
DROP TABLE "app"."artifact" CASCADE;--> statement-breakpoint
DROP POLICY "tenant" ON "app"."artifact_snapshot" CASCADE;--> statement-breakpoint
DROP POLICY "system" ON "app"."artifact_snapshot" CASCADE;--> statement-breakpoint
DROP TABLE "app"."artifact_snapshot" CASCADE;--> statement-breakpoint
DROP POLICY "tenant" ON "app"."artifact_version" CASCADE;--> statement-breakpoint
DROP POLICY "system" ON "app"."artifact_version" CASCADE;--> statement-breakpoint
DROP TABLE "app"."artifact_version" CASCADE;--> statement-breakpoint
drop function if exists app.artifact_version_immutable();--> statement-breakpoint
DROP POLICY "tenant" ON "app"."share_link" CASCADE;--> statement-breakpoint
DROP POLICY "system" ON "app"."share_link" CASCADE;--> statement-breakpoint
DROP TABLE "app"."share_link" CASCADE;--> statement-breakpoint
DROP POLICY "tenant" ON "app"."app_build" CASCADE;--> statement-breakpoint
DROP POLICY "system" ON "app"."app_build" CASCADE;--> statement-breakpoint
DROP TABLE "app"."app_build" CASCADE;--> statement-breakpoint
DROP POLICY "tenant" ON "app"."app_draft" CASCADE;--> statement-breakpoint
DROP POLICY "system" ON "app"."app_draft" CASCADE;--> statement-breakpoint
DROP TABLE "app"."app_draft" CASCADE;--> statement-breakpoint
DROP POLICY "tenant" ON "app"."app_result" CASCADE;--> statement-breakpoint
DROP POLICY "system" ON "app"."app_result" CASCADE;--> statement-breakpoint
DROP TABLE "app"."app_result" CASCADE;--> statement-breakpoint
ALTER TABLE "app"."run" DROP CONSTRAINT "run_profile_check";--> statement-breakpoint
ALTER TABLE "app"."thread" DROP CONSTRAINT "thread_channel_check";--> statement-breakpoint
ALTER TABLE "app"."context_item" DROP CONSTRAINT "context_item_anchor_check";--> statement-breakpoint
ALTER TABLE "app"."feedback" DROP CONSTRAINT "feedback_target_check";--> statement-breakpoint
DROP INDEX "app"."proposal_artifact_idx";--> statement-breakpoint
ALTER TABLE "app"."mcp_server" RENAME COLUMN "apps_allowed" TO "dashboards_allowed";--> statement-breakpoint
ALTER TABLE "app"."mcp_tool" RENAME COLUMN "apps_allowed" TO "dashboards_allowed";--> statement-breakpoint
ALTER TABLE "app"."dashboard" ADD CONSTRAINT "dashboard_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."dashboard" ADD CONSTRAINT "dashboard_org_id_project_id_project_org_id_id_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "app"."project"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."dashboard" ADD CONSTRAINT "dashboard_folder_fk" FOREIGN KEY ("org_id","project_id","folder_id") REFERENCES "app"."project"("org_id","parent_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."dashboard_draft" ADD CONSTRAINT "dashboard_draft_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."dashboard_draft" ADD CONSTRAINT "dashboard_draft_org_id_dashboard_id_dashboard_org_id_id_fk" FOREIGN KEY ("org_id","dashboard_id") REFERENCES "app"."dashboard"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."dashboard_result" ADD CONSTRAINT "dashboard_result_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."dashboard_version" ADD CONSTRAINT "dashboard_version_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."dashboard_version" ADD CONSTRAINT "dashboard_version_org_id_dashboard_id_dashboard_org_id_id_fk" FOREIGN KEY ("org_id","dashboard_id") REFERENCES "app"."dashboard"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dashboard_project_idx" ON "app"."dashboard" USING btree ("org_id","project_id");--> statement-breakpoint
CREATE INDEX "dashboard_updated_idx" ON "app"."dashboard" USING btree ("org_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "dashboard_owner_idx" ON "app"."dashboard" USING btree ("org_id","owner_id");--> statement-breakpoint
CREATE INDEX "dashboard_draft_bundle_idx" ON "app"."dashboard_draft" USING btree ("bundle_hash");--> statement-breakpoint
CREATE INDEX "dashboard_result_expires_idx" ON "app"."dashboard_result" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "dashboard_version_revision_uq" ON "app"."dashboard_version" USING btree ("org_id","revision");--> statement-breakpoint
CREATE INDEX "dashboard_version_bundle_idx" ON "app"."dashboard_version" USING btree ("bundle_hash");--> statement-breakpoint
ALTER TABLE "app"."proposal" DROP COLUMN "from_artifact_id";--> statement-breakpoint
ALTER TABLE "app"."proposal" DROP COLUMN "from_query_id";--> statement-breakpoint
ALTER TABLE "app"."routine_run" DROP COLUMN "report_id";--> statement-breakpoint
ALTER TABLE "app"."routine_run" DROP COLUMN "snapshot_id";--> statement-breakpoint
ALTER TABLE "app"."routine_run" DROP COLUMN "figures";--> statement-breakpoint
ALTER TABLE "app"."run" ADD CONSTRAINT "run_profile_check" CHECK ("app"."run"."profile" in ('analyst', 'investigator', 'modeler', 'drafter', 'curator', 'composer'));--> statement-breakpoint
ALTER TABLE "app"."thread" ADD CONSTRAINT "thread_channel_check" CHECK ("app"."thread"."channel" in ('web', 'api', 'eval', 'slack', 'insight', 'routine', 'modeler', 'curator'));--> statement-breakpoint
ALTER TABLE "app"."context_item" ADD CONSTRAINT "context_item_anchor_check" CHECK ("app"."context_item"."anchor_type" in ('none', 'connection', 'schema', 'table', 'column', 'dataset', 'metric', 'routine'));--> statement-breakpoint
ALTER TABLE "app"."feedback" ADD CONSTRAINT "feedback_target_check" CHECK ("app"."feedback"."target_type" in ('run', 'message', 'insight', 'todo', 'query_run', 'context_item', 'decision'));--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."dashboard" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."dashboard" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."dashboard_draft" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."dashboard_draft" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."dashboard_result" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."dashboard_result" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."dashboard_version" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."dashboard_version" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- A saved version is never changed: an edit, a restore or a check's new result is a new version.
create or replace function app.dashboard_version_immutable() returns trigger
  language plpgsql as $$
begin
  raise exception 'a dashboard_version is never changed: write a new version';
end
$$;
--> statement-breakpoint
create trigger dashboard_version_immutable before update on app.dashboard_version
  for each row execute function app.dashboard_version_immutable();
--> statement-breakpoint
-- A dashboard's parts bundle by its hash, for the frames origin, which serves frames without a session (and so with no
-- tenant): a saved version's, or a draft's live preview (only its owner's page signs a link to it). Code, never data:
-- a dashboard's data comes through the page around it, checked there. Nothing of a deleted dashboard.
create function app.dashboard_bundle(p_hash text) returns text
  language sql stable security definer
  set search_path = pg_catalog, pg_temp
  as $$
    select bundle from (
      select v.bundle from app.dashboard_version v
      join app.dashboard d on d.org_id = v.org_id and d.id = v.dashboard_id
      where v.bundle_hash = p_hash and v.bundle is not null and d.deleted_at is null
      union all
      select r.bundle from app.dashboard_draft r
      join app.dashboard d on d.org_id = r.org_id and d.id = r.dashboard_id
      where r.bundle_hash = p_hash and r.bundle is not null and d.deleted_at is null
    ) found
    limit 1
  $$;
--> statement-breakpoint
revoke all on function app.dashboard_bundle(text) from public;
--> statement-breakpoint
grant execute on function app.dashboard_bundle(text) to opendash_app;

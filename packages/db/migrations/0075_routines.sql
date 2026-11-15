-- Routines: everything that runs on its own is a routine, and a watched metric's state is the engine's
-- metric_check. Monitors, playbooks (dashboard emails and the weekly review) and the digest are gone, along with their
-- rows: nothing was in production. Written by hand to leave a fresh database (whose history never had them) and an
-- older one in the same state: every drop is `if exists`, and rows a tightened check would refuse are relabelled or
-- removed before it's added.
delete from app.effect where source_type in ('digest', 'snapshot', 'playbook_run');--> statement-breakpoint
alter table app.effect drop constraint if exists effect_source_check;--> statement-breakpoint
alter table app.effect add constraint effect_source_check
  check (source_type in ('insight', 'routine_run', 'approval', 'todo', 'tool_call'));--> statement-breakpoint
drop table if exists app.playbook_run, app.playbook, app.observation, app.monitor cascade;--> statement-breakpoint
alter table app.member_pref drop column if exists digest_rrule, drop column if exists next_digest_at,
  drop column if exists review_email;--> statement-breakpoint
-- Insights start afresh with the checks that find them (their investigations go with them; a task keeps its own copy).
delete from app.insight;--> statement-breakpoint
alter table app.insight drop column if exists monitor_id;--> statement-breakpoint
alter table app.insight add column check_id uuid;--> statement-breakpoint
-- A routine's agent runs (written summaries, scheduled questions) are trigger and channel `routine`.
alter table app.run drop constraint run_trigger_check;--> statement-breakpoint
update app.run set trigger = 'routine' where trigger = 'playbook';--> statement-breakpoint
alter table app.run add constraint run_trigger_check
  check (trigger in ('user', 'api', 'eval', 'slack', 'insight', 'routine', 'proposal'));--> statement-breakpoint
alter table app.thread drop constraint thread_channel_check;--> statement-breakpoint
update app.thread set channel = 'routine' where channel = 'playbook';--> statement-breakpoint
alter table app.thread add constraint thread_channel_check
  check (channel in ('web', 'api', 'eval', 'slack', 'insight', 'routine', 'modeler', 'curator'));--> statement-breakpoint
-- query_run is partitioned (0009, hand-written): the parent's check reaches every partition.
alter table app.query_run drop constraint query_run_requester_type_check;--> statement-breakpoint
update app.query_run set requester_type = 'check' where requester_type = 'monitor';--> statement-breakpoint
alter table app.query_run add constraint query_run_requester_type_check
  check (requester_type in ('run', 'artifact', 'check', 'eval', 'api', 'mcp', 'definition', 'task'));--> statement-breakpoint
alter table app.context_item drop constraint context_item_anchor_check;--> statement-breakpoint
alter table app.context_item add constraint context_item_anchor_check
  check (anchor_type in ('none', 'connection', 'schema', 'table', 'column', 'dataset', 'metric', 'routine', 'artifact'));--> statement-breakpoint
alter table app.feedback drop constraint feedback_route_check;--> statement-breakpoint
alter table app.feedback add constraint feedback_route_check
  check (route is null or route in ('personal', 'proposal', 'verified_candidate', 'eval_case', 'routine', 'discard'));--> statement-breakpoint
-- The workspace's time zone: its first owner's, where that's a zone Postgres knows; UTC otherwise. Core checks a zone
-- before it's saved (routines/schedule.ts).
alter table app.org add column tz text default 'UTC' not null;--> statement-breakpoint
update app.org o set tz = coalesce((
  select p.tz from auth.member m
  join app.member_pref p on p.org_id = m.organization_id and p.user_id = m.user_id
  where m.organization_id = o.id and m.role = 'owner' and p.tz in (select name from pg_timezone_names)
  order by m.created_at limit 1), 'UTC');--> statement-breakpoint
CREATE TABLE "app"."metric_check" (
	"org_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"metric_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"grain" text NOT NULL,
	"next_check_at" timestamp with time zone NOT NULL,
	"state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "metric_check_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "metric_check_grain_check" CHECK ("app"."metric_check"."grain" in ('week', 'month'))
);--> statement-breakpoint
ALTER TABLE "app"."metric_check" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."observation" (
	"org_id" uuid NOT NULL,
	"check_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"value" double precision NOT NULL,
	"expected" double precision,
	"expected_lo" double precision,
	"expected_hi" double precision,
	"spread" double precision,
	"score" double precision,
	"query_run_id" uuid,
	"row" integer NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "observation_org_id_check_id_period_start_pk" PRIMARY KEY("org_id","check_id","period_start")
);--> statement-breakpoint
ALTER TABLE "app"."observation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."routine" (
	"org_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"key" text,
	"name" text,
	"owner_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"spec" jsonb NOT NULL,
	"user_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"slack" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"next_run_at" timestamp with time zone,
	"status" text DEFAULT 'active' NOT NULL,
	"paused_reason" text,
	"failure_streak" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "routine_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "routine_trigger_check" CHECK ("app"."routine"."trigger" in ('schedule', 'found')),
	CONSTRAINT "routine_status_check" CHECK ("app"."routine"."status" in ('active', 'paused'))
);--> statement-breakpoint
ALTER TABLE "app"."routine" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."routine_run" (
	"org_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"routine_id" uuid NOT NULL,
	"trigger_key" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"due_at" timestamp with time zone,
	"spec_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"insight_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"run_id" uuid,
	"report_id" uuid,
	"snapshot_id" uuid,
	"figures" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "routine_run_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "routine_run_status_check" CHECK ("app"."routine_run"."status" in ('queued', 'running', 'writing', 'waiting', 'sending', 'delivered', 'failed', 'skipped'))
);--> statement-breakpoint
ALTER TABLE "app"."routine_run" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."metric_check" ADD CONSTRAINT "metric_check_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."observation" ADD CONSTRAINT "observation_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."routine" ADD CONSTRAINT "routine_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."routine_run" ADD CONSTRAINT "routine_run_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."routine_run" ADD CONSTRAINT "routine_run_org_id_routine_id_routine_org_id_id_fk" FOREIGN KEY ("org_id","routine_id") REFERENCES "app"."routine"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "metric_check_uq" ON "app"."metric_check" USING btree ("org_id","metric_id","grain") WHERE "app"."metric_check"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "metric_check_due_idx" ON "app"."metric_check" USING btree ("next_check_at") WHERE "app"."metric_check"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "routine_key_uq" ON "app"."routine" USING btree ("org_id","key") WHERE "app"."routine"."key" is not null and "app"."routine"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "routine_due_idx" ON "app"."routine" USING btree ("next_run_at") WHERE "app"."routine"."status" = 'active' and "app"."routine"."deleted_at" is null and "app"."routine"."next_run_at" is not null;--> statement-breakpoint
CREATE INDEX "routine_users_idx" ON "app"."routine" USING gin ("user_ids");--> statement-breakpoint
CREATE UNIQUE INDEX "routine_run_trigger_uq" ON "app"."routine_run" USING btree ("org_id","routine_id","trigger_key");--> statement-breakpoint
CREATE INDEX "routine_run_list_idx" ON "app"."routine_run" USING btree ("org_id","routine_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "routine_run_waiting_idx" ON "app"."routine_run" USING btree ("due_at") WHERE "app"."routine_run"."status" = 'waiting';--> statement-breakpoint
CREATE INDEX "routine_run_agent_idx" ON "app"."routine_run" USING btree ("org_id","run_id") WHERE "app"."routine_run"."run_id" is not null;--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."metric_check" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."metric_check" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."observation" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."observation" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."routine" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."routine" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."routine_run" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."routine_run" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);

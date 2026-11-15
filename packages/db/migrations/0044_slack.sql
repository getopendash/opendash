CREATE TABLE "app"."slack_conversation" (
	"org_id" uuid NOT NULL,
	"team_id" text NOT NULL,
	"slack_thread_id" text NOT NULL,
	"slack_user_id" text NOT NULL,
	"thread_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slack_conversation_org_id_team_id_slack_thread_id_slack_user_id_pk" PRIMARY KEY("org_id","team_id","slack_thread_id","slack_user_id")
);
--> statement-breakpoint
ALTER TABLE "app"."slack_conversation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."slack_link" (
	"org_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"team_id" text NOT NULL,
	"slack_user_id" text NOT NULL,
	"slack_user_name" text,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slack_link_org_id_id_pk" PRIMARY KEY("org_id","id")
);
--> statement-breakpoint
ALTER TABLE "app"."slack_link" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."slack_person" (
	"org_id" uuid NOT NULL,
	"team_id" text NOT NULL,
	"slack_user_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slack_person_org_id_team_id_slack_user_id_pk" PRIMARY KEY("org_id","team_id","slack_user_id")
);
--> statement-breakpoint
ALTER TABLE "app"."slack_person" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."slack_reply" (
	"org_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"team_id" text NOT NULL,
	"slack_thread_id" text NOT NULL,
	"slack_user_id" text NOT NULL,
	"status" text DEFAULT 'streaming' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "slack_reply_org_id_run_id_pk" PRIMARY KEY("org_id","run_id"),
	CONSTRAINT "slack_reply_status_check" CHECK ("app"."slack_reply"."status" in ('streaming', 'done', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "app"."slack_reply" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."slack_workspace" (
	"org_id" uuid NOT NULL,
	"team_id" text NOT NULL,
	"team_name" text NOT NULL,
	"team_domain" text,
	"bot_user_id" text NOT NULL,
	"secret_id" uuid,
	"connected_by" uuid,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slack_workspace_org_id_team_id_pk" PRIMARY KEY("org_id","team_id")
);
--> statement-breakpoint
ALTER TABLE "app"."slack_workspace" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."run" DROP CONSTRAINT "run_trigger_check";--> statement-breakpoint
ALTER TABLE "app"."thread" DROP CONSTRAINT "thread_channel_check";--> statement-breakpoint
ALTER TABLE "app"."slack_conversation" ADD CONSTRAINT "slack_conversation_org_id_thread_id_thread_org_id_id_fk" FOREIGN KEY ("org_id","thread_id") REFERENCES "app"."thread"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."slack_conversation" ADD CONSTRAINT "slack_conversation_org_id_team_id_slack_workspace_org_id_team_id_fk" FOREIGN KEY ("org_id","team_id") REFERENCES "app"."slack_workspace"("org_id","team_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."slack_link" ADD CONSTRAINT "slack_link_org_id_team_id_slack_workspace_org_id_team_id_fk" FOREIGN KEY ("org_id","team_id") REFERENCES "app"."slack_workspace"("org_id","team_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."slack_person" ADD CONSTRAINT "slack_person_org_id_team_id_slack_workspace_org_id_team_id_fk" FOREIGN KEY ("org_id","team_id") REFERENCES "app"."slack_workspace"("org_id","team_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."slack_reply" ADD CONSTRAINT "slack_reply_org_id_run_id_run_org_id_id_fk" FOREIGN KEY ("org_id","run_id") REFERENCES "app"."run"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."slack_workspace" ADD CONSTRAINT "slack_workspace_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."slack_workspace" ADD CONSTRAINT "slack_workspace_org_id_secret_id_secret_org_id_id_fk" FOREIGN KEY ("org_id","secret_id") REFERENCES "app"."secret"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "slack_link_token_uq" ON "app"."slack_link" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "slack_workspace_team_uq" ON "app"."slack_workspace" USING btree ("team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "slack_workspace_org_uq" ON "app"."slack_workspace" USING btree ("org_id");--> statement-breakpoint
ALTER TABLE "app"."run" ADD CONSTRAINT "run_trigger_check" CHECK ("app"."run"."trigger" in ('user', 'api', 'eval', 'slack'));--> statement-breakpoint
ALTER TABLE "app"."thread" ADD CONSTRAINT "thread_channel_check" CHECK ("app"."thread"."channel" in ('web', 'api', 'eval', 'slack'));--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."slack_conversation" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."slack_conversation" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."slack_link" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."slack_link" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."slack_person" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."slack_person" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."slack_reply" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."slack_reply" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."slack_workspace" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."slack_workspace" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);--> statement-breakpoint
-- Slack v0: which OpenDash workspace a Slack workspace belongs to, for events that arrive with no tenant (the
-- web's event route and the worker's socket). It returns only what's needed to act as that workspace's bot.
create function app.slack_team(p_team_id text)
  returns table (org_id uuid, secret_id uuid, bot_user_id text, team_name text)
  language sql stable security definer
  set search_path = pg_catalog, pg_temp
  as $$
    select w.org_id, w.secret_id, w.bot_user_id, w.team_name from app.slack_workspace w where w.team_id = p_team_id
  $$;
--> statement-breakpoint
revoke all on function app.slack_team(text) from public;
--> statement-breakpoint
grant execute on function app.slack_team(text) to opendash_app, opendash_system;
--> statement-breakpoint
-- Who is asking, from a Slack event: the workspace's org when the team is connected, the OpenDash user their
-- Slack account is linked to, and that user's role there, only while they're a member. No row: the team isn't
-- connected. A user and no role: linked, but no longer a member, so they're asked to link again.
create function app.slack_asker(p_team_id text, p_slack_user_id text)
  returns table (org_id uuid, user_id uuid, role text)
  language sql stable security definer
  set search_path = pg_catalog, pg_temp
  as $$
    select w.org_id, p.user_id, m.role from app.slack_workspace w
    left join app.slack_person p
      on p.org_id = w.org_id and p.team_id = w.team_id and p.slack_user_id = p_slack_user_id
    left join auth.member m on m.organization_id = w.org_id and m.user_id = p.user_id
    where w.team_id = p_team_id
  $$;
--> statement-breakpoint
revoke all on function app.slack_asker(text, text) from public;
--> statement-breakpoint
grant execute on function app.slack_asker(text, text) to opendash_app, opendash_system;
--> statement-breakpoint
-- Which workspace a person's conversation in a Slack thread belongs to, for events that carry no team (Slack's stop
-- button): only the conversation's org and team, and only for that thread and person.
create function app.slack_conversation_of(p_slack_thread_id text, p_slack_user_id text)
  returns table (org_id uuid, team_id text)
  language sql stable security definer
  set search_path = pg_catalog, pg_temp
  as $$
    select c.org_id, c.team_id from app.slack_conversation c
    where c.slack_thread_id = p_slack_thread_id and c.slack_user_id = p_slack_user_id
  $$;
--> statement-breakpoint
revoke all on function app.slack_conversation_of(text, text) from public;
--> statement-breakpoint
grant execute on function app.slack_conversation_of(text, text) to opendash_app, opendash_system;
--> statement-breakpoint
-- A link to confirm a Slack account, by its token's hash: open, unexpired and unused, or no row. The signed-in member
-- who opens it is checked against the workspace it names before anything is linked.
create function app.resolve_slack_link(p_token_hash text)
  returns table (org_id uuid, id uuid, team_id text, slack_user_id text, slack_user_name text, team_name text)
  language sql stable security definer
  set search_path = pg_catalog, pg_temp
  as $$
    select l.org_id, l.id, l.team_id, l.slack_user_id, l.slack_user_name, w.team_name from app.slack_link l
    join app.slack_workspace w on w.org_id = l.org_id and w.team_id = l.team_id
    where l.token_hash = p_token_hash and l.used_at is null and l.expires_at > now()
  $$;
--> statement-breakpoint
revoke all on function app.resolve_slack_link(text) from public;
--> statement-breakpoint
grant execute on function app.resolve_slack_link(text) to opendash_app;
--> statement-breakpoint
-- Chat SDK's state (@chat-adapter/state-pg 4.41.0, autoCreateSchema off): thread subscriptions, locks, the dedupe cache,
-- lists and queues. Slack keeps the messages, so no message text is stored here. Infrastructure, not tenant data: only
-- opendash_system uses it, through search_path = chat.
create schema chat authorization opendash_owner;
--> statement-breakpoint
create table chat.chat_state_subscriptions (
  key_prefix text not null,
  thread_id text not null,
  created_at timestamptz not null default now(),
  primary key (key_prefix, thread_id)
);
--> statement-breakpoint
create table chat.chat_state_locks (
  key_prefix text not null,
  thread_id text not null,
  token text not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (key_prefix, thread_id)
);
--> statement-breakpoint
create table chat.chat_state_cache (
  key_prefix text not null,
  cache_key text not null,
  value text not null,
  expires_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (key_prefix, cache_key)
);
--> statement-breakpoint
create index chat_state_locks_expires_idx on chat.chat_state_locks (expires_at);
--> statement-breakpoint
create index chat_state_cache_expires_idx on chat.chat_state_cache (expires_at);
--> statement-breakpoint
create table chat.chat_state_lists (
  key_prefix text not null,
  list_key text not null,
  seq bigserial not null,
  value text not null,
  expires_at timestamptz,
  primary key (key_prefix, list_key, seq)
);
--> statement-breakpoint
create index chat_state_lists_expires_idx on chat.chat_state_lists (expires_at);
--> statement-breakpoint
create table chat.chat_state_queues (
  key_prefix text not null,
  thread_id text not null,
  seq bigserial not null,
  value text not null,
  expires_at timestamptz not null,
  primary key (key_prefix, thread_id, seq)
);
--> statement-breakpoint
create index chat_state_queues_expires_idx on chat.chat_state_queues (expires_at);
--> statement-breakpoint
revoke all on schema chat from public;
--> statement-breakpoint
grant usage on schema chat to opendash_system;
--> statement-breakpoint
grant select, insert, update, delete on all tables in schema chat to opendash_system;
--> statement-breakpoint
grant usage, update on all sequences in schema chat to opendash_system;

CREATE TABLE "app"."effect" (
	"org_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid,
	"channel" text NOT NULL,
	"integration_id" uuid,
	"recipient_key" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"interrupt" boolean DEFAULT false NOT NULL,
	"tier" text,
	"idempotency_key" text NOT NULL,
	"approval_id" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"provider_ref" text,
	"receipt" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "effect_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "effect_purpose_check" CHECK ("app"."effect"."purpose" in ('notify', 'action')),
	CONSTRAINT "effect_source_check" CHECK ("app"."effect"."source_type" in ('insight', 'routine_run', 'approval', 'todo', 'tool_call')),
	CONSTRAINT "effect_channel_check" CHECK ("app"."effect"."channel" in ('slack', 'teams', 'email', 'webhook', 'in_app', 'linear', 'jira', 'mcp')),
	CONSTRAINT "effect_status_check" CHECK ("app"."effect"."status" in ('queued', 'sending', 'sent', 'failed', 'suppressed', 'unknown'))
);
--> statement-breakpoint
ALTER TABLE "app"."effect" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."effect" ADD CONSTRAINT "effect_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "effect_idempotency_uq" ON "app"."effect" USING btree ("org_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "effect_interrupt_idx" ON "app"."effect" USING btree ("org_id","recipient_key","sent_at") WHERE "app"."effect"."interrupt";--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."effect" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."effect" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);--> statement-breakpoint
-- Delivery needs the recipient's address, which lives in the auth schema that opendash_app can't read.
-- Like app.route_inbound, this narrow function answers one question for the current organization only: is this
-- person a member, and what's their address? Members can already see each other's addresses (Better Auth's member
-- list), so it shows nothing new; it takes no org id.
create function app.member_recipient(p_user_id uuid) returns table (email text, name text)
  language sql stable security definer
  set search_path = pg_catalog, pg_temp
  as $$
    select u.email, u.name from auth.member m
    join auth."user" u on u.id = m.user_id
    where m.organization_id = app.org_id() and m.user_id = p_user_id
  $$;
--> statement-breakpoint
revoke all on function app.member_recipient(uuid) from public;
--> statement-breakpoint
grant execute on function app.member_recipient(uuid) to opendash_app;

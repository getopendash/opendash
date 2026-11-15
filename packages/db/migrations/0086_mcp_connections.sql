CREATE TABLE "app"."mcp_connection" (
	"org_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"scope_id" uuid,
	"secret_id" uuid NOT NULL,
	"issuer" text,
	"account" text,
	"account_key" text,
	"discovery" jsonb,
	"status" text DEFAULT 'ready' NOT NULL,
	"message" text,
	"refreshing_until" timestamp with time zone,
	"revision" integer DEFAULT 1 NOT NULL,
	"connected_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"refreshed_at" timestamp with time zone,
	CONSTRAINT "mcp_connection_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "mcp_connection_scope_check" CHECK ("app"."mcp_connection"."scope" in ('org', 'personal')),
	CONSTRAINT "mcp_connection_scope_id_check" CHECK (("app"."mcp_connection"."scope" = 'personal') = ("app"."mcp_connection"."scope_id" is not null)),
	CONSTRAINT "mcp_connection_status_check" CHECK ("app"."mcp_connection"."status" in ('ready', 'reconnect', 'wrong_account'))
);
--> statement-breakpoint
ALTER TABLE "app"."mcp_connection" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."mcp_oauth_flow" (
	"org_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"scope_id" uuid,
	"started_by" uuid NOT NULL,
	"state_hash" text NOT NULL,
	"secret_id" uuid NOT NULL,
	"issuer" text,
	"discovery" jsonb,
	"redirect_url" text NOT NULL,
	"connection_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_oauth_flow_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "mcp_oauth_flow_scope_check" CHECK ("app"."mcp_oauth_flow"."scope" in ('org', 'personal')),
	CONSTRAINT "mcp_oauth_flow_scope_id_check" CHECK (("app"."mcp_oauth_flow"."scope" = 'personal') = ("app"."mcp_oauth_flow"."scope_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "app"."mcp_oauth_flow" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."mcp_server" (
	"org_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"auth" text DEFAULT 'oauth' NOT NULL,
	"access" text DEFAULT 'personal' NOT NULL,
	"apps_allowed" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"scopes" text,
	"client_secret_id" uuid,
	"issuer" text,
	"tools_listed_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_server_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "mcp_server_auth_check" CHECK ("app"."mcp_server"."auth" in ('oauth', 'none')),
	CONSTRAINT "mcp_server_access_check" CHECK ("app"."mcp_server"."access" in ('personal', 'shared')),
	CONSTRAINT "mcp_server_status_check" CHECK ("app"."mcp_server"."status" in ('active', 'disabled'))
);
--> statement-breakpoint
ALTER TABLE "app"."mcp_server" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."mcp_tool" (
	"org_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"name" text NOT NULL,
	"title" text,
	"description" text,
	"input_schema" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"annotations" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"digest" text NOT NULL,
	"reviewed_digest" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"tier" text DEFAULT 'ask' NOT NULL,
	"apps_allowed" boolean DEFAULT false NOT NULL,
	"listed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_tool_org_id_server_id_name_pk" PRIMARY KEY("org_id","server_id","name"),
	CONSTRAINT "mcp_tool_status_check" CHECK ("app"."mcp_tool"."status" in ('active', 'changed', 'removed')),
	CONSTRAINT "mcp_tool_tier_check" CHECK ("app"."mcp_tool"."tier" in ('always', 'ask', 'blocked'))
);
--> statement-breakpoint
ALTER TABLE "app"."mcp_tool" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."mcp_connection" ADD CONSTRAINT "mcp_connection_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."mcp_connection" ADD CONSTRAINT "mcp_connection_org_id_server_id_mcp_server_org_id_id_fk" FOREIGN KEY ("org_id","server_id") REFERENCES "app"."mcp_server"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."mcp_connection" ADD CONSTRAINT "mcp_connection_org_id_secret_id_secret_org_id_id_fk" FOREIGN KEY ("org_id","secret_id") REFERENCES "app"."secret"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."mcp_oauth_flow" ADD CONSTRAINT "mcp_oauth_flow_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."mcp_oauth_flow" ADD CONSTRAINT "mcp_oauth_flow_org_id_server_id_mcp_server_org_id_id_fk" FOREIGN KEY ("org_id","server_id") REFERENCES "app"."mcp_server"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."mcp_oauth_flow" ADD CONSTRAINT "mcp_oauth_flow_org_id_secret_id_secret_org_id_id_fk" FOREIGN KEY ("org_id","secret_id") REFERENCES "app"."secret"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."mcp_server" ADD CONSTRAINT "mcp_server_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."mcp_server" ADD CONSTRAINT "mcp_server_org_id_client_secret_id_secret_org_id_id_fk" FOREIGN KEY ("org_id","client_secret_id") REFERENCES "app"."secret"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."mcp_tool" ADD CONSTRAINT "mcp_tool_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."mcp_tool" ADD CONSTRAINT "mcp_tool_org_id_server_id_mcp_server_org_id_id_fk" FOREIGN KEY ("org_id","server_id") REFERENCES "app"."mcp_server"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_connection_org_uq" ON "app"."mcp_connection" USING btree ("org_id","server_id") WHERE "app"."mcp_connection"."scope" = 'org';--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_connection_personal_uq" ON "app"."mcp_connection" USING btree ("org_id","server_id","scope_id") WHERE "app"."mcp_connection"."scope" = 'personal';--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_oauth_flow_state_uq" ON "app"."mcp_oauth_flow" USING btree ("org_id","state_hash");--> statement-breakpoint
CREATE INDEX "mcp_oauth_flow_expires_idx" ON "app"."mcp_oauth_flow" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_server_url_uq" ON "app"."mcp_server" USING btree ("org_id","url");--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."mcp_connection" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id()) and (scope <> 'personal' or scope_id = (select app.user_id()))) WITH CHECK (org_id = (select app.org_id()) and (scope <> 'personal' or scope_id = (select app.user_id())));--> statement-breakpoint
CREATE POLICY "system" ON "app"."mcp_connection" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."mcp_oauth_flow" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id()) and (scope <> 'personal' or scope_id = (select app.user_id()))) WITH CHECK (org_id = (select app.org_id()) and (scope <> 'personal' or scope_id = (select app.user_id())));--> statement-breakpoint
CREATE POLICY "system" ON "app"."mcp_oauth_flow" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."mcp_server" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."mcp_server" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."mcp_tool" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."mcp_tool" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);--> statement-breakpoint
-- A connection's tokens, a sign-in's verifier and a server's client registration are secrets of kind `mcp` that only
-- their row points at, so each goes with its row however the row is deleted. Removing a server cascades to every
-- person's connection, including the ones row security hides from the admin removing it; their secrets go too.
-- Not SECURITY DEFINER: the deleting role sees its organization's secrets.
create function app.mcp_drop_secret() returns trigger
  language plpgsql
  set search_path = pg_catalog, pg_temp
  as $$
    begin
      delete from app.secret where org_id = old.org_id and id = (to_jsonb(old) ->> tg_argv[0])::uuid;
      return old;
    end
  $$;
--> statement-breakpoint
create trigger mcp_connection_drop_secret after delete on app.mcp_connection
  for each row execute function app.mcp_drop_secret('secret_id');
--> statement-breakpoint
create trigger mcp_oauth_flow_drop_secret after delete on app.mcp_oauth_flow
  for each row execute function app.mcp_drop_secret('secret_id');
--> statement-breakpoint
create trigger mcp_server_drop_secret after delete on app.mcp_server
  for each row execute function app.mcp_drop_secret('client_secret_id');

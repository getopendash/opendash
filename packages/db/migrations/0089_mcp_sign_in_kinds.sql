-- Every way an MCP server signs people in: OAuth (a registration OpenDash makes, or one
-- an admin enters), an API key (in Authorization or a header the server names, each person's own or one for
-- everyone), or nothing. A server that needs no sign-in has one connection for everyone by nature, so it's shared.
update app.mcp_server set access = 'shared' where auth = 'none';
--> statement-breakpoint
ALTER TABLE "app"."mcp_server" DROP CONSTRAINT "mcp_server_auth_check";--> statement-breakpoint
ALTER TABLE "app"."mcp_server" ADD COLUMN "transport" text DEFAULT 'streamable' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."mcp_server" ADD COLUMN "key_header" text;--> statement-breakpoint
ALTER TABLE "app"."mcp_server" ADD COLUMN "key_hint" text;--> statement-breakpoint
ALTER TABLE "app"."mcp_server" ADD COLUMN "client_source" text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."mcp_server" ADD CONSTRAINT "mcp_server_none_shared_check" CHECK ("app"."mcp_server"."auth" <> 'none' or "app"."mcp_server"."access" = 'shared');--> statement-breakpoint
ALTER TABLE "app"."mcp_server" ADD CONSTRAINT "mcp_server_transport_check" CHECK ("app"."mcp_server"."transport" in ('streamable', 'sse'));--> statement-breakpoint
ALTER TABLE "app"."mcp_server" ADD CONSTRAINT "mcp_server_client_source_check" CHECK ("app"."mcp_server"."client_source" in ('auto', 'admin'));--> statement-breakpoint
ALTER TABLE "app"."mcp_server" ADD CONSTRAINT "mcp_server_client_issuer_check" CHECK ("app"."mcp_server"."client_source" <> 'admin' or "app"."mcp_server"."issuer" is not null);--> statement-breakpoint
ALTER TABLE "app"."mcp_server" ADD CONSTRAINT "mcp_server_auth_check" CHECK ("app"."mcp_server"."auth" in ('oauth', 'apikey', 'none'));
--> statement-breakpoint
-- How many people connected their own account to each server, and how many of those need to sign in again: counts for
-- the workspace's owners and admins, never who. Row security hides a personal connection from everyone but its person
-- (the personal boundary), so this reads past it and answers nothing to anyone else.
create function app.mcp_connection_counts() returns table (server_id uuid, connected integer, attention integer)
  language sql stable security definer
  set search_path = pg_catalog, pg_temp
  as $$
    select c.server_id, count(*)::int, (count(*) filter (where c.status <> 'ready'))::int
    from app.mcp_connection c
    where c.org_id = app.org_id() and c.scope = 'personal'
      and app.member_role(app.user_id()) in ('owner', 'admin')
    group by c.server_id
  $$;
--> statement-breakpoint
revoke all on function app.mcp_connection_counts() from public;
--> statement-breakpoint
grant execute on function app.mcp_connection_counts() to opendash_app;

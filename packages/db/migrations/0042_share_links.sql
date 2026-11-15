CREATE TABLE "app"."share_link" (
	"org_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"target_type" text DEFAULT 'artifact' NOT NULL,
	"target_id" uuid NOT NULL,
	"mode" text DEFAULT 'snapshot' NOT NULL,
	"token_hash" text NOT NULL,
	"created_by" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "share_link_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "share_link_target_check" CHECK ("app"."share_link"."target_type" = 'artifact'),
	CONSTRAINT "share_link_mode_check" CHECK ("app"."share_link"."mode" = 'snapshot')
);
--> statement-breakpoint
ALTER TABLE "app"."share_link" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."share_link" ADD CONSTRAINT "share_link_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."share_link" ADD CONSTRAINT "share_link_org_id_target_id_artifact_org_id_id_fk" FOREIGN KEY ("org_id","target_id") REFERENCES "app"."artifact"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "share_link_token_uq" ON "app"."share_link" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "share_link_open_uq" ON "app"."share_link" USING btree ("org_id","target_id") WHERE "app"."share_link"."revoked_at" is null;--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."share_link" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."share_link" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);--> statement-breakpoint
-- A share link's token, hashed, to the report it opens. Called in a transaction with no
-- tenant, so it alone decides: the link open and unexpired, its workspace's public links on, the report there and a
-- report, and its owner still a member. Anything else is no row, the same for every reason.
create function app.resolve_share(p_token_hash text) returns table (org_id uuid, artifact_id uuid, expires_at timestamptz)
  language sql stable security definer
  set search_path = pg_catalog, pg_temp
  as $$
    select s.org_id, s.target_id, s.expires_at from app.share_link s
    join app.org o on o.id = s.org_id and o.settings->>'share_links' = 'true'
    join app.artifact a on a.org_id = s.org_id and a.id = s.target_id and a.kind = 'report' and a.deleted_at is null
    join auth.member m on m.organization_id = s.org_id and m.user_id = a.owner_id
    where s.token_hash = p_token_hash and s.revoked_at is null and s.expires_at > now()
  $$;
--> statement-breakpoint
revoke all on function app.resolve_share(text) from public;
--> statement-breakpoint
grant execute on function app.resolve_share(text) to opendash_app;

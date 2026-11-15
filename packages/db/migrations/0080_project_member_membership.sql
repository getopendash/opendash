-- Membership ends what it granted. A project's people are its organization's members:
-- their roles go with the membership (as slack_identity's link, 0068), so someone invited back starts with none.
-- Roles left from memberships that already ended go first: ones with no membership now, and ones given before the
-- membership there is now began (they left and were invited back, so the role came back with them).
DELETE FROM "app"."project_member" pm
WHERE NOT EXISTS (
  SELECT 1 FROM "auth"."member" m WHERE m."organization_id" = pm."org_id" AND m."user_id" = pm."principal_id"
    AND m."created_at" <= pm."created_at"
);--> statement-breakpoint
ALTER TABLE "app"."project_member" ADD CONSTRAINT "project_member_member_fk" FOREIGN KEY ("org_id","principal_id") REFERENCES "auth"."member"("organization_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- A link its owner made before their current membership began (they left and were invited back) never opens again.
create or replace function app.resolve_share(p_token_hash text) returns table (org_id uuid, artifact_id uuid, expires_at timestamptz)
  language sql stable security definer
  set search_path = pg_catalog, pg_temp
  as $$
    select s.org_id, s.target_id, s.expires_at from app.share_link s
    join app.org o on o.id = s.org_id and o.settings->>'share_links' = 'true'
    join app.artifact a on a.org_id = s.org_id and a.id = s.target_id and a.kind = 'report' and a.deleted_at is null
    join auth.member m on m.organization_id = s.org_id and m.user_id = a.owner_id and m.created_at <= s.created_at
    where s.token_hash = p_token_hash and s.revoked_at is null and s.expires_at > now()
  $$;
--> statement-breakpoint
revoke all on function app.resolve_share(text) from public;
--> statement-breakpoint
grant execute on function app.resolve_share(text) to opendash_app;

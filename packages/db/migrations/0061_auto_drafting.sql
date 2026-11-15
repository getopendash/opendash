-- Automatic drafting: a source keeps at most one batch held for the background budget, which resumes it.
CREATE UNIQUE INDEX "proposal_source_held_uq" ON "app"."proposal" USING btree ("org_id","connection_id") WHERE "app"."proposal"."from_query_run_id" is null and "app"."proposal"."status" = 'held';
--> statement-breakpoint
-- A member's role in the current organization, or none: the worker drafts automatically only as an owner or admin
-- who still is one. Nothing else about the member.
create function app.member_role(p_user_id uuid) returns text
  language sql stable security definer
  set search_path = pg_catalog, pg_temp
  as $$
    select m.role from auth.member m where m.organization_id = app.org_id() and m.user_id = p_user_id
  $$;
--> statement-breakpoint
revoke all on function app.member_role(uuid) from public;
--> statement-breakpoint
grant execute on function app.member_role(uuid) to opendash_app;

-- Slack installs like any app, Go 1. A Slack account linked to a member is app.slack_identity (was
-- slack_person), removed by the database when the membership goes; a workspace
-- Slack took back (uninstalled there, or its token revoked) keeps its row with removed_at set and no token.
ALTER TABLE "app"."slack_person" RENAME TO "slack_identity";--> statement-breakpoint
ALTER TABLE "app"."slack_identity" RENAME CONSTRAINT "slack_person_org_id_team_id_slack_user_id_pk" TO "slack_identity_org_id_team_id_slack_user_id_pk";--> statement-breakpoint
ALTER TABLE "app"."slack_identity" RENAME CONSTRAINT "slack_person_org_id_team_id_slack_workspace_org_id_team_id_fk" TO "slack_identity_org_id_team_id_slack_workspace_org_id_team_id_fk";--> statement-breakpoint
ALTER TABLE "app"."slack_identity" ADD COLUMN "slack_user_name" text;--> statement-breakpoint
-- Links to people who are no longer members (until now removed on their next question), then one link per person,
-- the newest kept.
DELETE FROM "app"."slack_identity" i
WHERE NOT EXISTS (
  SELECT 1 FROM "auth"."member" m WHERE m."organization_id" = i."org_id" AND m."user_id" = i."user_id"
);--> statement-breakpoint
DELETE FROM "app"."slack_identity" i USING "app"."slack_identity" j
WHERE i."org_id" = j."org_id" AND i."user_id" = j."user_id"
  AND (i."linked_at", i."slack_user_id") < (j."linked_at", j."slack_user_id");--> statement-breakpoint
-- Better Auth keeps one membership per person per organization in code; this makes it the database's too, and fails
-- here, loudly, if it ever didn't.
CREATE UNIQUE INDEX "member_organization_user_uq" ON "auth"."member" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "slack_identity_user_uq" ON "app"."slack_identity" USING btree ("org_id","user_id");--> statement-breakpoint
ALTER TABLE "app"."slack_identity" ADD CONSTRAINT "slack_identity_member_fk" FOREIGN KEY ("org_id","user_id") REFERENCES "auth"."member"("organization_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."slack_workspace" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."slack_workspace" ADD COLUMN "removed_why" text;--> statement-breakpoint
ALTER TABLE "app"."slack_workspace" ADD CONSTRAINT "slack_workspace_removed_check" CHECK (("app"."slack_workspace"."removed_at" is null and "app"."slack_workspace"."removed_why" is null) or ("app"."slack_workspace"."removed_at" is not null and "app"."slack_workspace"."removed_why" in ('uninstalled', 'tokens_revoked') and "app"."slack_workspace"."secret_id" is null));--> statement-breakpoint
UPDATE "app"."slack_workspace" w SET "connected_by" = NULL
WHERE w."connected_by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "auth"."user" u WHERE u."id" = w."connected_by");--> statement-breakpoint
ALTER TABLE "app"."slack_workspace" ADD CONSTRAINT "slack_workspace_connected_by_user_id_fk" FOREIGN KEY ("connected_by") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Who is asking, from a Slack event: as before, reading the renamed table. A SQL function's body is read
-- when it runs, so it's replaced with the table's new name.
create or replace function app.slack_asker(p_team_id text, p_slack_user_id text)
  returns table (org_id uuid, user_id uuid, role text)
  language sql stable security definer
  set search_path = pg_catalog, pg_temp
  as $$
    select w.org_id, p.user_id, m.role from app.slack_workspace w
    left join app.slack_identity p
      on p.org_id = w.org_id and p.team_id = w.team_id and p.slack_user_id = p_slack_user_id
    left join auth.member m on m.organization_id = w.org_id and m.user_id = p.user_id
    where w.team_id = p_team_id
  $$;

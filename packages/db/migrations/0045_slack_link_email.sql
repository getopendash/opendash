ALTER TABLE "app"."slack_link" ADD COLUMN "slack_user_email" text;--> statement-breakpoint
-- The link's Slack account email, for the check that it's the confirming person's own (a link forwarded to a colleague
-- would otherwise tie their OpenDash account to the sender's Slack account). The return type grows, so the function is
-- replaced.
drop function app.resolve_slack_link(text);
--> statement-breakpoint
create function app.resolve_slack_link(p_token_hash text)
  returns table (
    org_id uuid, id uuid, team_id text, slack_user_id text, slack_user_name text, slack_user_email text, team_name text
  )
  language sql stable security definer
  set search_path = pg_catalog, pg_temp
  as $$
    select l.org_id, l.id, l.team_id, l.slack_user_id, l.slack_user_name, l.slack_user_email, w.team_name
    from app.slack_link l
    join app.slack_workspace w on w.org_id = l.org_id and w.team_id = l.team_id
    where l.token_hash = p_token_hash and l.used_at is null and l.expires_at > now()
  $$;
--> statement-breakpoint
revoke all on function app.resolve_slack_link(text) from public;
--> statement-breakpoint
grant execute on function app.resolve_slack_link(text) to opendash_app;

-- A member whose address isn't verified is still a member: their sends are held, their settings kept (0037 made them
-- look like someone who left). The function now says whether the address is verified, for the caller to decide.
drop function app.member_recipient(uuid);
--> statement-breakpoint
create function app.member_recipient(p_user_id uuid) returns table (email text, name text, verified boolean)
  language sql stable security definer
  set search_path = pg_catalog, pg_temp
  as $$
    select u.email, u.name, u.email_verified from auth.member m
    join auth."user" u on u.id = m.user_id
    where m.organization_id = app.org_id() and m.user_id = p_user_id
  $$;
--> statement-breakpoint
revoke all on function app.member_recipient(uuid) from public;
--> statement-breakpoint
grant execute on function app.member_recipient(uuid) to opendash_app;

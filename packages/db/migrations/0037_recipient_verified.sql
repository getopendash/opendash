-- Delivery goes only to a verified address (defence in depth: today every account is made through an email link).
create or replace function app.member_recipient(p_user_id uuid) returns table (email text, name text)
  language sql stable security definer
  set search_path = pg_catalog, pg_temp
  as $$
    select u.email, u.name from auth.member m
    join auth."user" u on u.id = m.user_id
    where m.organization_id = app.org_id() and m.user_id = p_user_id and u.email_verified
  $$;

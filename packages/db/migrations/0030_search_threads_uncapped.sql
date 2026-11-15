-- The conversations list's search without a cap. 0029's app.search_threads stopped at k matches before the caller applied who may read
-- each thread, so other people's private matches could use up the cap and push a person's own out of their results:
-- a side channel on what others' conversations contain. It now returns every match in the organization (ids only),
-- so what a person gets depends only on what they can read; the caller still pages.
drop function app.search_threads(text[], int);
--> statement-breakpoint
create function app.search_threads(patterns text[]) returns setof uuid
  language sql stable security definer
  set search_path = app, pg_temp
  as $$
    with candidates as (
      select t.id from thread t
      where t.org_id = app.org_id() and t.title ilike patterns[1] escape '\'
      union
      select m.thread_id from message m
      where m.org_id = app.org_id() and m.role in ('user', 'assistant') and m.kind = 'normal' and m.text is not null
        and m.text ilike patterns[1] escape '\'
      union
      select r.thread_id from run r
      where r.org_id = app.org_id() and r.parent_run_id is null and r.outcome is not null
        and coalesce(r.outcome->>'rendered', r.outcome->>'question', r.outcome->>'reason') ilike patterns[1] escape '\'
    )
    select t.id from candidates c
    join thread t on t.org_id = app.org_id() and t.id = c.id and t.deleted_at is null
    where not exists (
      select 1 from unnest(patterns[2:]) p
      where not (
        t.title ilike p escape '\'
        or exists (
          select 1 from message m
          where m.org_id = t.org_id and m.thread_id = t.id and m.role in ('user', 'assistant') and m.kind = 'normal'
            and m.text is not null and m.text ilike p escape '\')
        or exists (
          select 1 from run r
          where r.org_id = t.org_id and r.thread_id = t.id and r.parent_run_id is null and r.outcome is not null
            and coalesce(r.outcome->>'rendered', r.outcome->>'question', r.outcome->>'reason') ilike p escape '\')))
  $$;
--> statement-breakpoint
revoke all on function app.search_threads(text[]) from public;
--> statement-breakpoint
grant execute on function app.search_threads(text[]) to opendash_app;

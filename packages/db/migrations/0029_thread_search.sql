CREATE INDEX "message_text_trgm_idx" ON "app"."message" USING gin ("org_id","text" gin_trgm_ops) WHERE "app"."message"."role" in ('user', 'assistant') and "app"."message"."kind" = 'normal' and "app"."message"."text" is not null;--> statement-breakpoint
CREATE INDEX "run_outcome_text_trgm_idx" ON "app"."run" USING gin ("org_id",(coalesce("outcome"->>'rendered', "outcome"->>'question', "outcome"->>'reason')) gin_trgm_ops) WHERE "app"."run"."parent_run_id" is null and "app"."run"."outcome" is not null;--> statement-breakpoint
CREATE INDEX "thread_title_trgm_idx" ON "app"."thread" USING gin ("org_id","title" gin_trgm_ops);--> statement-breakpoint
-- The conversations list's search (SECURITY DEFINER search functions): the current organization's threads in which every pattern
-- (an ILIKE pattern, escaped with \) appears in the title, a question, the analyst's notes, or what a run gave the
-- reader (the answer as shown, a question asked back, why it couldn't answer); never in tool results. ILIKE can't be
-- an index condition under RLS, so this runs as the owner and keeps to app.org_id() itself. Who may read each thread
-- is the caller's to check. The first pattern finds candidates through the trigram indexes: pass the most selective.
create or replace function app.search_threads(patterns text[], k int) returns setof uuid
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
    limit k
  $$;
--> statement-breakpoint
revoke all on function app.search_threads(text[], int) from public;
--> statement-breakpoint
grant execute on function app.search_threads(text[], int) to opendash_app;

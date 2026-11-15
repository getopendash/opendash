-- A metric query's trace: the metric_query spec it was
-- compiled from and the definitions it used, each as (item, version), so an answer on the metric path can say which
-- definition it read, and a later edit doesn't change what an old answer meant. Until releases exist, these versions
-- are the record of which definitions were live.
alter table app.query_run add column semantic jsonb;
--> statement-breakpoint
-- A version is never edited: a change is a new version. Only `derived` (what the validation job found) is filled in
-- afterwards.
create or replace function app.context_item_version_immutable() returns trigger
  language plpgsql as $$
begin
  if new.org_id is distinct from old.org_id or new.item_id is distinct from old.item_id
     or new.version is distinct from old.version or new.body is distinct from old.body
     or new.body_hash is distinct from old.body_hash or new.spec is distinct from old.spec
     or new.source is distinct from old.source or new.author_id is distinct from old.author_id then
    raise exception 'a context_item_version is never changed: write a new version';
  end if;
  return new;
end
$$;
--> statement-breakpoint
create trigger context_item_version_immutable before update on app.context_item_version
  for each row execute function app.context_item_version_immutable();

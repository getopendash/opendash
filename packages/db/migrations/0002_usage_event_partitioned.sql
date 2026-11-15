-- Partition maintenance. Owned by opendash_owner, run by opendash_system
-- through the maint.partitions job. No DEFAULT partition: a write with no partition fails loudly.
create or replace function app.ensure_partitions(parent text, period text, ahead int default 3) returns int
  language plpgsql security definer
  set search_path = app, pg_temp
  as $$
  declare
    first_ts timestamptz := date_trunc(period, now());
    from_ts timestamptz;
    to_ts timestamptz;
    part text;
    created int := 0;
  begin
    if period not in ('day', 'month') then
      raise exception 'period must be day or month, got %', period;
    end if;
    for i in 0..ahead loop
      from_ts := first_ts + make_interval(days => case when period = 'day' then i else 0 end,
                                          months => case when period = 'month' then i else 0 end);
      to_ts := from_ts + case when period = 'day' then interval '1 day' else interval '1 month' end;
      part := format('%s_p%s', parent, to_char(from_ts, case when period = 'day' then 'YYYYMMDD' else 'YYYYMM' end));
      if to_regclass(format('app.%I', part)) is null then
        execute format('create table app.%I partition of app.%I for values from (%L) to (%L)',
                       part, parent, app.uuidv7_floor(from_ts), app.uuidv7_floor(to_ts));
        -- Partitions get RLS with no policies: reads through the parent use the parent's policies, and direct reads of
        -- a partition return nothing.
        execute format('alter table app.%I enable row level security', part);
        created := created + 1;
      end if;
    end loop;
    return created;
  end $$;
--> statement-breakpoint
-- Number of the next `ahead` periods (including the current one) that have no partition. Alerting checks this is 0.
create or replace function app.missing_partitions(parent text, period text, ahead int default 3) returns int
  language plpgsql stable security definer
  set search_path = app, pg_temp
  as $$
  declare
    first_ts timestamptz := date_trunc(period, now());
    missing int := 0;
    part text;
  begin
    for i in 0..ahead loop
      part := format('%s_p%s', parent,
        to_char(first_ts + make_interval(days => case when period = 'day' then i else 0 end,
                                         months => case when period = 'month' then i else 0 end),
                case when period = 'day' then 'YYYYMMDD' else 'YYYYMM' end));
      if to_regclass(format('app.%I', part)) is null then
        missing := missing + 1;
      end if;
    end loop;
    return missing;
  end $$;
--> statement-breakpoint
-- Drops partitions whose upper bound is older than `keep` (retention). Returns the dropped partition names.
create or replace function app.drop_partitions_before(parent text, keep interval) returns setof text
  language plpgsql security definer
  set search_path = app, pg_temp
  as $$
  declare
    r record;
    cutoff uuid := app.uuidv7_floor(now() - keep);
  begin
    for r in
      select c.relname, (regexp_match(pg_get_expr(c.relpartbound, c.oid), 'TO \(''([^'']+)''\)'))[1]::uuid as upper_bound
      from pg_inherits i
      join pg_class c on c.oid = i.inhrelid
      join pg_class p on p.oid = i.inhparent
      join pg_namespace n on n.oid = p.relnamespace
      where n.nspname = 'app' and p.relname = parent
    loop
      if r.upper_bound <= cutoff then
        execute format('drop table app.%I', r.relname);
        return next r.relname;
      end if;
    end loop;
  end $$;
--> statement-breakpoint
grant execute on function app.ensure_partitions(text, text, int) to opendash_system;
--> statement-breakpoint
grant execute on function app.missing_partitions(text, text, int) to opendash_system;
--> statement-breakpoint
grant execute on function app.drop_partitions_before(text, interval) to opendash_system;
--> statement-breakpoint
-- Usage events: written in the same transaction as the ledger row that caused them, so each is counted exactly once.
create table app.usage_event (
  id uuid not null,
  org_id uuid not null,
  kind text not null check (kind in ('llm_tokens', 'query', 'bytes_scanned', 'embedding', 'export')),
  qty double precision not null,
  unit text not null,
  model text,
  provider text,
  cost_usd numeric(14, 6),
  credits bigint,
  source_type text,
  source_id uuid,
  user_id uuid
) partition by range (id);
--> statement-breakpoint
create index usage_event_org_id_idx on app.usage_event (org_id, id);
--> statement-breakpoint
alter table app.usage_event enable row level security;
--> statement-breakpoint
create policy tenant on app.usage_event as permissive for all to opendash_app
  using (org_id = (select app.org_id())) with check (org_id = (select app.org_id()));
--> statement-breakpoint
create policy system on app.usage_event as permissive for all to opendash_system using (true) with check (true);
--> statement-breakpoint
select app.ensure_partitions('usage_event', 'month', 3);

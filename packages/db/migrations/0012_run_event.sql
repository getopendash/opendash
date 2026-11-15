-- The run's event stream: what a run did, in order, for
-- the trace and for clients that poll. A buffer, not a record: messages and tool_calls stay canonical, so partitions
-- are dropped after 3 days (self-host 7) by the maint.partitions job, which also creates the days ahead. Daily
-- RANGE(id) partitions on uuidv7, with no DEFAULT partition and no primary key.
create table app.run_event (
  id uuid not null,
  org_id uuid not null,
  run_id uuid not null,
  attempt integer not null,
  seq integer not null,
  type text not null,
  data jsonb not null default '{}',
  created_at timestamptz not null default now()
) partition by range (id);
--> statement-breakpoint
create index run_event_run_idx on app.run_event (org_id, run_id, seq);
--> statement-breakpoint
alter table app.run_event enable row level security;
--> statement-breakpoint
create policy tenant on app.run_event as permissive for all to opendash_app
  using (org_id = (select app.org_id())) with check (org_id = (select app.org_id()));
--> statement-breakpoint
create policy system on app.run_event as permissive for all to opendash_system using (true) with check (true);
--> statement-breakpoint
select app.ensure_partitions('run_event', 'day', 3);

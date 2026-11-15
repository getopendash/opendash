-- The trace behind every number: one row per query OpenDash runs or checks on a
-- source. Answers cite cells of these rows; nothing else can produce a number. Partitioned monthly by id (uuidv7),
-- like usage_event; references into it are soft (no FKs), and retention keeps pinned rows (later).
create table app.query_run (
  id uuid not null,
  org_id uuid not null,
  connection_id uuid not null,
  requester_type text not null check (requester_type in ('run', 'artifact', 'check', 'eval', 'api', 'mcp')),
  requester_id uuid,
  tool_call_id uuid,
  alias text,
  mode text not null check (mode in ('explain', 'execute')),
  path text not null default 'raw_sql' check (path in ('verified_query', 'metric', 'model_sql', 'raw_sql', 'compute')),
  engine text not null default 'agent_sql' check (engine in ('compiler', 'agent_sql', 'duckdb')),
  title text,
  compiled_sql text not null,
  sql_hash text not null,
  status text not null check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'timeout', 'abandoned')),
  error jsonb,
  rows integer,
  truncated boolean not null default false,
  bytes bigint,
  duration_ms integer,
  result_schema jsonb,
  preview jsonb,
  result_hash text,
  sanity jsonb not null default '[]',
  pinned_at timestamptz,
  created_at timestamptz not null default now()
) partition by range (id);
--> statement-breakpoint
create index query_run_requester_idx on app.query_run (org_id, requester_type, requester_id, id);
--> statement-breakpoint
create index query_run_connection_idx on app.query_run (org_id, connection_id, id);
--> statement-breakpoint
alter table app.query_run enable row level security;
--> statement-breakpoint
create policy tenant on app.query_run as permissive for all to opendash_app
  using (org_id = (select app.org_id())) with check (org_id = (select app.org_id()));
--> statement-breakpoint
create policy system on app.query_run as permissive for all to opendash_system using (true) with check (true);
--> statement-breakpoint
select app.ensure_partitions('query_run', 'month', 3);

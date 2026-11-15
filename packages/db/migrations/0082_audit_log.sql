-- The audit log: who changed what that matters for security, one row per action. The app writes a row in the action's
-- own transaction where the action is ours; Better Auth's actions (sign-in, members, keys) are written by its hooks
-- right after it commits. A row names the fields that changed, never their values. Partitioned monthly by id (uuidv7)
-- like usage_event; retention drops whole partitions. Rows are never changed: the app role may only insert and read,
-- and a trigger lets the system role set the chain columns once (ee/'s sealer) and nothing else.
create table app.audit_log (
  id uuid not null,
  org_id uuid not null,
  created_at timestamptz not null default now(),
  actor_type text not null check (actor_type in ('user', 'api_key', 'scim', 'slack', 'system')),
  actor_id uuid,
  -- Who it was when it happened, so the row still reads after they leave.
  actor_name text,
  action text not null,
  target_type text,
  target_id uuid,
  target_name text,
  -- The names of the fields that changed, never their values.
  fields text[] not null default '{}',
  -- The event's own non-secret facts (a role, a count, a kind), typed per action in @opendash/core/audit.
  detail jsonb not null default '{}',
  ip inet,
  user_agent text,
  -- The hash chain (ee/), set once by the sealer: the row's place in its organization's chain, the hash before it and
  -- its own. Null until sealed.
  seq bigint,
  prev_hash bytea,
  hash bytea,
  primary key (org_id, id)
) partition by range (id);
--> statement-breakpoint
create index audit_log_actor_idx on app.audit_log (org_id, actor_id, id);
--> statement-breakpoint
create index audit_log_action_idx on app.audit_log (org_id, action, id);
--> statement-breakpoint
create index audit_log_unsealed_idx on app.audit_log (org_id, id) where hash is null;
--> statement-breakpoint
create index audit_log_seq_idx on app.audit_log (org_id, seq) where seq is not null;
--> statement-breakpoint
alter table app.audit_log enable row level security;
--> statement-breakpoint
create policy tenant on app.audit_log as permissive for all to opendash_app
  using (org_id = (select app.org_id())) with check (org_id = (select app.org_id()));
--> statement-breakpoint
create policy system on app.audit_log as permissive for all to opendash_system using (true) with check (true);
--> statement-breakpoint
revoke update, delete on app.audit_log from opendash_app;
--> statement-breakpoint
revoke delete on app.audit_log from opendash_system;
--> statement-breakpoint
-- Rows are never changed or removed. The one update allowed is the sealer's (the system role) setting the chain columns
-- of a row not yet sealed; the one delete is an organization's purge, inside app.purge_audit_log as the owner.
create or replace function app.audit_log_guard() returns trigger
  language plpgsql
  set search_path = app, pg_temp
  as $$
  begin
    if tg_op = 'DELETE' then
      if current_user = 'opendash_owner' and current_setting('app.audit_purge', true) = 'on' then
        return old;
      end if;
      raise exception 'audit_log rows are never deleted' using errcode = 'insufficient_privilege';
    end if;
    if current_user <> 'opendash_system' then
      raise exception 'audit_log rows are never changed' using errcode = 'insufficient_privilege';
    end if;
    if old.seq is not null or old.hash is not null then
      raise exception 'audit_log row % is already sealed', old.id using errcode = 'insufficient_privilege';
    end if;
    if new.seq is null or new.hash is null then
      raise exception 'sealing sets seq and hash' using errcode = 'check_violation';
    end if;
    if (new.id, new.org_id, new.created_at, new.actor_type, new.actor_id, new.actor_name, new.action, new.target_type,
        new.target_id, new.target_name, new.fields, new.detail, new.ip, new.user_agent)
       is distinct from
       (old.id, old.org_id, old.created_at, old.actor_type, old.actor_id, old.actor_name, old.action, old.target_type,
        old.target_id, old.target_name, old.fields, old.detail, old.ip, old.user_agent) then
      raise exception 'sealing changes only seq, prev_hash and hash' using errcode = 'insufficient_privilege';
    end if;
    return new;
  end $$;
--> statement-breakpoint
create trigger audit_log_guard before update or delete on app.audit_log
  for each row execute function app.audit_log_guard();
--> statement-breakpoint
-- Each organization's chain head (ee/): the last sealed row. The sealer advances it with a compare-and-set on seq, so
-- two sealers never fork a chain (one fails and its batch rolls back). Its row also marks an organization whose
-- history was purged (purged_at), so Verify says why the chain starts later.
create table app.audit_chain (
  org_id uuid not null primary key,
  seq bigint not null default 0,
  hash bytea,
  sealed_at timestamptz,
  purged_at timestamptz
);
--> statement-breakpoint
alter table app.audit_chain enable row level security;
--> statement-breakpoint
create policy tenant on app.audit_chain as permissive for all to opendash_app
  using (org_id = (select app.org_id())) with check (org_id = (select app.org_id()));
--> statement-breakpoint
create policy system on app.audit_chain as permissive for all to opendash_system using (true) with check (true);
--> statement-breakpoint
revoke insert, update, delete on app.audit_chain from opendash_app;
--> statement-breakpoint
-- An organization's purge (ee/, owners): every row of the organization in the caller's tenant context, and its chain
-- restarts. The caller writes the "audit log purged" row in the same transaction, so the purge is itself the first row.
create or replace function app.purge_audit_log() returns bigint
  language plpgsql security definer
  set search_path = app, pg_temp
  as $$
  declare
    org uuid := app.org_id();
    n bigint;
  begin
    if org is null then
      raise exception 'no tenant context' using errcode = 'insufficient_privilege';
    end if;
    perform set_config('app.audit_purge', 'on', true);
    delete from app.audit_log where org_id = org;
    get diagnostics n = row_count;
    perform set_config('app.audit_purge', 'off', true);
    insert into app.audit_chain (org_id, seq, hash, sealed_at, purged_at) values (org, 0, null, null, now())
      on conflict (org_id) do update set seq = 0, hash = null, sealed_at = null, purged_at = now();
    return n;
  end $$;
--> statement-breakpoint
grant execute on function app.purge_audit_log() to opendash_app;
--> statement-breakpoint
select app.ensure_partitions('audit_log', 'month', 3);

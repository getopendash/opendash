-- Tenant context functions used by every RLS policy.
-- nullif(…, '') because a pooled session that ran set_config(…, true) earlier holds '' afterwards, and ''::uuid throws.
create or replace function app.org_id() returns uuid
  language sql stable parallel safe
  as $$ select nullif(current_setting('app.org_id', true), '')::uuid $$;
--> statement-breakpoint
create or replace function app.user_id() returns uuid
  language sql stable parallel safe
  as $$ select nullif(current_setting('app.user_id', true), '')::uuid $$;
--> statement-breakpoint
grant execute on function app.org_id() to opendash_app, opendash_system;
--> statement-breakpoint
grant execute on function app.user_id() to opendash_app, opendash_system;
--> statement-breakpoint
-- The smallest uuidv7 for a timestamp: 48-bit unix milliseconds, version 7, variant 10, all random bits zero.
-- RANGE(id) partition bounds on uuidv7 columns are built from it.
create or replace function app.uuidv7_floor(ts timestamptz) returns uuid
  language sql immutable parallel safe
  as $$
    select (lpad(to_hex(floor(extract(epoch from ts) * 1000)::bigint), 12, '0') || '7000' || '8000' || '000000000000')::uuid
  $$;
--> statement-breakpoint
-- The timestamp a uuidv7 encodes (millisecond precision).
create or replace function app.uuidv7_ts(id uuid) returns timestamptz
  language sql immutable parallel safe
  as $$ select to_timestamp(('x' || substr(replace(id::text, '-', ''), 1, 12))::bit(48)::bigint / 1000.0) $$;
--> statement-breakpoint
grant execute on function app.uuidv7_floor(timestamptz) to opendash_app, opendash_system;
--> statement-breakpoint
grant execute on function app.uuidv7_ts(uuid) to opendash_app, opendash_system;

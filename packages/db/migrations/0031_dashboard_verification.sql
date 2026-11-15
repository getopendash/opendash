ALTER TABLE "app"."artifact" ADD COLUMN "verification" jsonb;--> statement-breakpoint
-- Dashboards from before Stale were verified against their metrics as released now: record that, so none turn Stale
-- on deploy. A metric deleted since is recorded as null (verified knowing it's gone).
update app.artifact a set verification = jsonb_build_object(
    'with', coalesce((
      select jsonb_object_agg(b.value->>'itemId', case when i.deleted_at is null then i.released_version end)
      from app.artifact_version v
      cross join jsonb_each(v.bindings) b
      left join app.context_item i on i.org_id = v.org_id
        and i.id::text = lower(b.value->>'itemId')
      where v.org_id = a.org_id and v.artifact_id = a.id and v.version = a.current_version
        and b.value->>'kind' = 'metric'), '{}'::jsonb),
    'at', a.updated_at, 'trigger', 'save', 'changed', '[]'::jsonb, 'problems', '[]'::jsonb)
  where a.verification is null;

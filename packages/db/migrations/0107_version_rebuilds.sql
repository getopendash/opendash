-- A version's code is never changed, but its build may be redone from that same code (Apps built before select to edit
-- were built again so that their pieces are marked). An update is allowed only when it changes nothing but the bundle
-- and its hash; anything else still raises.
CREATE OR REPLACE FUNCTION "app"."dashboard_version_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
begin
  if (to_jsonb(new) - 'bundle' - 'bundle_hash') = (to_jsonb(old) - 'bundle' - 'bundle_hash') then
    return new;
  end if;
  raise exception 'a dashboard_version is never changed: write a new version';
end
$$;

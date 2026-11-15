-- The kit's page-at-a-time dashboards are gone (Apps are code now; the old ones are deleted, none shipped): each one
-- still standing as one is marked deleted, kept, so it can be brought back.
UPDATE "app"."dashboard" AS d SET "deleted_at" = now()
WHERE d."deleted_at" IS NULL
  AND coalesce(
    (SELECT r."definition"->>'version' FROM "app"."dashboard_draft" r WHERE r."org_id" = d."org_id" AND r."dashboard_id" = d."id"),
    (SELECT v."definition"->>'version' FROM "app"."dashboard_version" v
      WHERE v."org_id" = d."org_id" AND v."dashboard_id" = d."id" AND v."version" = d."current_version")
  ) = '1';

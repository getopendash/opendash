-- Someone's private background work is theirs alone: its conversations carry them as
-- their owner from the start (thread.created_by). Ones made before have none: a private routine's runs (a routine that
-- reaches only its owner) and a private finding's investigation (its latest run, the one it keeps) get theirs now.
UPDATE "app"."thread" t SET "created_by" = x."owner"
FROM (
  SELECT r."org_id", r."thread_id", ro."owner_id" AS "owner"
  FROM "app"."run" r
  JOIN "app"."routine_run" rr ON rr."org_id" = r."org_id" AND rr."run_id" = r."id"
  JOIN "app"."routine" ro ON ro."org_id" = rr."org_id" AND ro."id" = rr."routine_id"
  WHERE ro."key" IS NULL AND jsonb_array_length(ro."slack") = 0
    AND NOT EXISTS (SELECT 1 FROM unnest(ro."user_ids") u WHERE u <> ro."owner_id")
) x
WHERE t."org_id" = x."org_id" AND t."id" = x."thread_id" AND t."channel" = 'routine' AND t."created_by" IS NULL;
--> statement-breakpoint
UPDATE "app"."thread" t SET "created_by" = x."owner"
FROM (
  SELECT r."org_id", r."thread_id", n."owner_id" AS "owner"
  FROM "app"."investigation" v
  JOIN "app"."run" r ON r."org_id" = v."org_id" AND r."id" = v."run_id"
  JOIN "app"."insight" n ON n."org_id" = v."org_id" AND n."id" = v."insight_id"
  WHERE n."owner_id" IS NOT NULL
) x
WHERE t."org_id" = x."org_id" AND t."id" = x."thread_id" AND t."channel" = 'insight' AND t."created_by" IS NULL;

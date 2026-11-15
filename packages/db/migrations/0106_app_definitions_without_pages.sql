-- An App's definition has no pages (the kit is gone): the old schema stored an empty "pages" (and "nav")
-- on every App's draft and version, which the App schema now refuses. Each is taken out, on Apps only; a version is
-- otherwise never changed, so its guard is lifted for this one statement and put back.
UPDATE "app"."dashboard_draft" SET "definition" = "definition" - 'pages' - 'nav'
WHERE "definition"->>'version' = '2' AND ("definition" ? 'pages' OR "definition" ? 'nav');--> statement-breakpoint
ALTER TABLE "app"."dashboard_version" DISABLE TRIGGER "dashboard_version_immutable";--> statement-breakpoint
UPDATE "app"."dashboard_version" SET "definition" = "definition" - 'pages' - 'nav'
WHERE "definition"->>'version' = '2' AND ("definition" ? 'pages' OR "definition" ? 'nav');--> statement-breakpoint
ALTER TABLE "app"."dashboard_version" ENABLE TRIGGER "dashboard_version_immutable";

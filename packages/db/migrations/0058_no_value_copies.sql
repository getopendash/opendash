-- OpenDash keeps no copy of a source's values. Every column profile keeps its stats only, and the value
-- index goes with the columns that described it.
UPDATE "app"."catalog_object" SET "profile" = "profile" - 'top' - 'min' - 'max' - 'maxValue', "updated_at" = now()
WHERE "kind" = 'column' AND "profile" ?| array['top', 'min', 'max', 'maxValue'];--> statement-breakpoint
DROP POLICY "tenant" ON "app"."column_value" CASCADE;--> statement-breakpoint
DROP POLICY "system" ON "app"."column_value" CASCADE;--> statement-breakpoint
DROP TABLE "app"."column_value" CASCADE;--> statement-breakpoint
ALTER TABLE "app"."catalog_object" DROP CONSTRAINT "catalog_object_values_state_check";--> statement-breakpoint
ALTER TABLE "app"."catalog_object" DROP COLUMN "values_state";--> statement-breakpoint
ALTER TABLE "app"."catalog_object" DROP COLUMN "values_count";
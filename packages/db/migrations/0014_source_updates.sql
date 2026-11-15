-- Changing an existing source's settings or password is a test of the new settings ("update"), applied to
-- the source once, when it passes (applied_at).
ALTER TABLE "app"."connection_test" DROP CONSTRAINT "connection_test_purpose_check";--> statement-breakpoint
ALTER TABLE "app"."connection_test" ADD COLUMN "applied_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."connection_test" ADD CONSTRAINT "connection_test_purpose_check" CHECK ("app"."connection_test"."purpose" in ('connect', 'recheck', 'update'));
-- Test connection on an existing source: connection checks now have a purpose. A connection is still created
-- from exactly one "connect" test; "recheck" tests of it may be run any number of times.
DROP INDEX "app"."connection_test_connection_uq";--> statement-breakpoint
ALTER TABLE "app"."connection_test" ADD COLUMN "purpose" text DEFAULT 'connect' NOT NULL;--> statement-breakpoint
CREATE INDEX "connection_test_source_idx" ON "app"."connection_test" USING btree ("org_id","connection_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "connection_test_connection_uq" ON "app"."connection_test" USING btree ("org_id","connection_id") WHERE "app"."connection_test"."purpose" = 'connect';--> statement-breakpoint
ALTER TABLE "app"."connection_test" ADD CONSTRAINT "connection_test_purpose_check" CHECK ("app"."connection_test"."purpose" in ('connect', 'recheck'));
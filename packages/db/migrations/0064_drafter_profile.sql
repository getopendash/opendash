-- The Modeler's helpers: a run's profile may be 'drafter', a child run drafting a group of tables. Only
-- widens the check. It's re-validated under a short exclusive lock on app.run; on a large table the way is ADD
-- CONSTRAINT … NOT VALID, then VALIDATE CONSTRAINT.
ALTER TABLE "app"."run" DROP CONSTRAINT "run_profile_check";--> statement-breakpoint
ALTER TABLE "app"."run" ADD CONSTRAINT "run_profile_check" CHECK ("app"."run"."profile" in ('analyst', 'investigator', 'reviewer', 'modeler', 'drafter'));
-- A note from OpenDash that reports (work picked up when a run resumed) is kind 'report', so it's never read
-- as a nudge to end the run. Only widens the check; it's re-validated under a short exclusive lock on app.message, and
-- on a large table the way is ADD CONSTRAINT … NOT VALID, then VALIDATE CONSTRAINT.
ALTER TABLE "app"."message" DROP CONSTRAINT "message_kind_check";--> statement-breakpoint
ALTER TABLE "app"."message" ADD CONSTRAINT "message_kind_check" CHECK ("app"."message"."kind" in ('normal', 'compaction', 'queued_input', 'report'));
-- The Reviewer: routines' written
-- summaries are background work (trigger routine) by the Reviewer in a thread that's nobody's conversation (channel
-- routine).
ALTER TABLE "app"."run" DROP CONSTRAINT "run_trigger_check";--> statement-breakpoint
ALTER TABLE "app"."run" DROP CONSTRAINT "run_profile_check";--> statement-breakpoint
ALTER TABLE "app"."thread" DROP CONSTRAINT "thread_channel_check";--> statement-breakpoint
ALTER TABLE "app"."run" ADD CONSTRAINT "run_trigger_check" CHECK ("app"."run"."trigger" in ('user', 'api', 'eval', 'slack', 'insight', 'routine'));--> statement-breakpoint
ALTER TABLE "app"."run" ADD CONSTRAINT "run_profile_check" CHECK ("app"."run"."profile" in ('analyst', 'investigator', 'reviewer'));--> statement-breakpoint
ALTER TABLE "app"."thread" ADD CONSTRAINT "thread_channel_check" CHECK ("app"."thread"."channel" in ('web', 'api', 'eval', 'slack', 'insight', 'routine'));

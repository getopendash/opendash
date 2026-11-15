-- Learning from corrections: the Curator's runs (profile curator, channel curator) and a learning's test
-- runs (trigger proposal, the unreleased term they're tested with in run.candidate, set only on those); proposals
-- that update a term, from the Curator, one live per topic (dedupe_key), evaluating, discarded or reverted too; the
-- Modeler's one-a-source indexes now say they're the Modeler's; and a structural eval case (expect: the tables and
-- filter an answer must read, and the ones it mustn't), graded without a reference.
ALTER TABLE "app"."run" DROP CONSTRAINT "run_trigger_check";--> statement-breakpoint
ALTER TABLE "app"."run" DROP CONSTRAINT "run_profile_check";--> statement-breakpoint
ALTER TABLE "app"."thread" DROP CONSTRAINT "thread_channel_check";--> statement-breakpoint
ALTER TABLE "app"."proposal" DROP CONSTRAINT "proposal_kind_check";--> statement-breakpoint
ALTER TABLE "app"."proposal" DROP CONSTRAINT "proposal_source_check";--> statement-breakpoint
ALTER TABLE "app"."proposal" DROP CONSTRAINT "proposal_status_check";--> statement-breakpoint
ALTER TABLE "app"."eval_case" DROP CONSTRAINT "eval_case_reference_check";--> statement-breakpoint
DROP INDEX "app"."proposal_source_live_uq";--> statement-breakpoint
DROP INDEX "app"."proposal_source_held_uq";--> statement-breakpoint
ALTER TABLE "app"."run" ADD COLUMN "candidate" jsonb;--> statement-breakpoint
ALTER TABLE "app"."proposal" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
ALTER TABLE "app"."eval_case" ADD COLUMN "expect" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "proposal_topic_live_uq" ON "app"."proposal" USING btree ("org_id","dedupe_key") WHERE "app"."proposal"."source" = 'curator' and "app"."proposal"."status" in ('drafting', 'held', 'evaluating', 'open');--> statement-breakpoint
CREATE UNIQUE INDEX "proposal_source_live_uq" ON "app"."proposal" USING btree ("org_id","connection_id") WHERE "app"."proposal"."source" = 'modeler' and "app"."proposal"."from_query_run_id" is null and "app"."proposal"."status" = 'drafting';--> statement-breakpoint
CREATE UNIQUE INDEX "proposal_source_held_uq" ON "app"."proposal" USING btree ("org_id","connection_id") WHERE "app"."proposal"."source" = 'modeler' and "app"."proposal"."from_query_run_id" is null and "app"."proposal"."status" = 'held';--> statement-breakpoint
ALTER TABLE "app"."run" ADD CONSTRAINT "run_candidate_check" CHECK ("app"."run"."candidate" is null or "app"."run"."trigger" = 'proposal');--> statement-breakpoint
ALTER TABLE "app"."run" ADD CONSTRAINT "run_trigger_check" CHECK ("app"."run"."trigger" in ('user', 'api', 'eval', 'slack', 'insight', 'routine', 'proposal'));--> statement-breakpoint
ALTER TABLE "app"."run" ADD CONSTRAINT "run_profile_check" CHECK ("app"."run"."profile" in ('analyst', 'investigator', 'reviewer', 'modeler', 'drafter', 'curator'));--> statement-breakpoint
ALTER TABLE "app"."thread" ADD CONSTRAINT "thread_channel_check" CHECK ("app"."thread"."channel" in ('web', 'api', 'eval', 'slack', 'insight', 'routine', 'modeler', 'curator'));--> statement-breakpoint
ALTER TABLE "app"."proposal" ADD CONSTRAINT "proposal_kind_check" CHECK ("app"."proposal"."kind" in ('create', 'update'));--> statement-breakpoint
ALTER TABLE "app"."proposal" ADD CONSTRAINT "proposal_source_check" CHECK ("app"."proposal"."source" in ('modeler', 'curator'));--> statement-breakpoint
ALTER TABLE "app"."proposal" ADD CONSTRAINT "proposal_status_check" CHECK ("app"."proposal"."status" in ('drafting', 'held', 'failed', 'evaluating', 'open', 'approved', 'rejected', 'superseded', 'discarded', 'reverted'));--> statement-breakpoint
ALTER TABLE "app"."eval_case" ADD CONSTRAINT "eval_case_reference_check" CHECK ("app"."eval_case"."reference_spec" is not null or "app"."eval_case"."reference_sql" is not null or "app"."eval_case"."expect" is not null);
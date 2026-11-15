ALTER TABLE "app"."spend_limit" ADD COLUMN "background_monthly_usd" numeric(12, 2) DEFAULT '10' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."spend_limit" ADD CONSTRAINT "spend_limit_background_check" CHECK ("app"."spend_limit"."background_monthly_usd" >= 0);--> statement-breakpoint
-- Which recorded model calls were background work's (the Investigator, routines), so its own budget counts them and
-- the questions' limits don't. usage_event is partitioned (0002, hand-written): the column reaches every partition.
alter table app.usage_event add column background boolean not null default false;

ALTER TABLE "app"."run" DROP CONSTRAINT "run_reasoning_check";--> statement-breakpoint
ALTER TABLE "app"."ai_settings" DROP CONSTRAINT "ai_settings_reasoning_check";--> statement-breakpoint
ALTER TABLE "app"."run" ALTER COLUMN "reasoning" SET DEFAULT 'high';--> statement-breakpoint
ALTER TABLE "app"."eval_run" ALTER COLUMN "reasoning" SET DEFAULT 'high';--> statement-breakpoint
ALTER TABLE "app"."ai_settings" ALTER COLUMN "default_reasoning" SET DEFAULT 'high';--> statement-breakpoint
-- The standard effort levels: each stored level becomes the effort it sent its model (Auto was a model's
-- default: high for Claude and Gemini, medium for GPT; Deep was extra high for Claude, high for GPT).
UPDATE "app"."run" SET "reasoning" = CASE
  WHEN "reasoning" = 'quick' THEN 'low'
  WHEN "reasoning" = 'max' THEN 'max'
  WHEN "reasoning" = 'deep' THEN CASE WHEN "model" LIKE 'gpt%' THEN 'high' ELSE 'xhigh' END
  ELSE CASE WHEN "model" LIKE 'gpt%' THEN 'medium' ELSE 'high' END
END WHERE "reasoning" IN ('auto', 'quick', 'deep', 'max');--> statement-breakpoint
UPDATE "app"."eval_run" SET "reasoning" = CASE
  WHEN "reasoning" = 'quick' THEN 'low'
  WHEN "reasoning" = 'max' THEN 'max'
  WHEN "reasoning" = 'deep' THEN 'xhigh'
  ELSE 'high'
END WHERE "reasoning" IN ('auto', 'quick', 'deep', 'max');--> statement-breakpoint
UPDATE "app"."ai_settings" SET "default_reasoning" = CASE
  WHEN "default_reasoning" = 'quick' THEN 'low'
  WHEN "default_reasoning" = 'max' THEN 'max'
  WHEN "default_reasoning" = 'deep' THEN CASE WHEN "default_model" LIKE 'gpt%' THEN 'high' ELSE 'xhigh' END
  ELSE CASE WHEN "default_model" LIKE 'gpt%' THEN 'medium' ELSE 'high' END
END WHERE "default_reasoning" IN ('auto', 'quick', 'deep', 'max');--> statement-breakpoint
ALTER TABLE "app"."run" ADD CONSTRAINT "run_reasoning_check" CHECK ("app"."run"."reasoning" in ('low', 'medium', 'high', 'xhigh', 'max'));--> statement-breakpoint
ALTER TABLE "app"."ai_settings" ADD CONSTRAINT "ai_settings_reasoning_check" CHECK ("app"."ai_settings"."default_reasoning" in ('low', 'medium', 'high', 'xhigh', 'max'));
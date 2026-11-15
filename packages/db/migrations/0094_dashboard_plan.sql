ALTER TABLE "app"."dashboard" ADD COLUMN "plan" jsonb;--> statement-breakpoint
ALTER TABLE "app"."dashboard" ADD COLUMN "plan_run_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "dashboard_plan_run_uq" ON "app"."dashboard" USING btree ("org_id","plan_run_id") WHERE "app"."dashboard"."plan_run_id" is not null;
ALTER TABLE "app"."insight" ADD COLUMN "owner_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."routine_run" ADD COLUMN "attempt" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "insight_owner_idx" ON "app"."insight" USING btree ("org_id","owner_id") WHERE "app"."insight"."owner_id" is not null;--> statement-breakpoint
CREATE INDEX "effect_routine_run_idx" ON "app"."effect" USING btree ("org_id","source_id") WHERE "app"."effect"."source_type" = 'routine_run';
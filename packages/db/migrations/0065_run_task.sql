-- What a child run was given by its parent: a drafter's tables. One child per task per parent. Additive.
ALTER TABLE "app"."run" ADD COLUMN "task" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "run_child_task_uq" ON "app"."run" USING btree ("org_id","parent_run_id","task") WHERE "app"."run"."parent_run_id" is not null;
-- Changes left running from before (a stopped process): settled unknown first, never sent again, so one row has at
-- most one running when the index below is made.
UPDATE "app"."dashboard_action" SET "status" = 'unknown', "settled_at" = now(),
  "result" = 'The service didn''t answer, so OpenDash can''t tell whether it changed: check there before trying again.'
  WHERE "status" = 'running';--> statement-breakpoint
CREATE UNIQUE INDEX "dashboard_action_running_uq" ON "app"."dashboard_action" USING btree ("org_id","dashboard_id","section","record_key") WHERE status = 'running';

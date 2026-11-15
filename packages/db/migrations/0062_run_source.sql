-- Several sources in one conversation: the source a question starts from, which a follow-up can switch.
-- Null for earlier runs, which started from their thread's.
ALTER TABLE "app"."run" ADD COLUMN "connection_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."run" ADD CONSTRAINT "run_org_id_connection_id_connection_org_id_id_fk" FOREIGN KEY ("org_id","connection_id") REFERENCES "app"."connection"("org_id","id") ON DELETE no action ON UPDATE no action;
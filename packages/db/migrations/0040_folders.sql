ALTER TABLE "app"."thread" ADD COLUMN "folder_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."artifact" ADD COLUMN "folder_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."project" ADD CONSTRAINT "project_parent_uq" UNIQUE("org_id","parent_id","id");
--> statement-breakpoint
ALTER TABLE "app"."thread" ADD CONSTRAINT "thread_folder_fk" FOREIGN KEY ("org_id","project_id","folder_id") REFERENCES "app"."project"("org_id","parent_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."artifact" ADD CONSTRAINT "artifact_folder_fk" FOREIGN KEY ("org_id","project_id","folder_id") REFERENCES "app"."project"("org_id","parent_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."project" ADD CONSTRAINT "project_folder_parent_check" CHECK (("app"."project"."kind" = 'project') = ("app"."project"."parent_id" is null));
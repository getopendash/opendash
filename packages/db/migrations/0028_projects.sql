CREATE TABLE "app"."project" (
	"org_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"kind" text DEFAULT 'project' NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"visibility" text DEFAULT 'private' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "project_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "project_slug_uq" UNIQUE NULLS NOT DISTINCT("org_id","parent_id","slug"),
	CONSTRAINT "project_kind_check" CHECK ("app"."project"."kind" in ('project', 'folder')),
	CONSTRAINT "project_visibility_check" CHECK ("app"."project"."visibility" in ('private', 'org'))
);
--> statement-breakpoint
ALTER TABLE "app"."project" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."project_member" (
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"principal_type" text DEFAULT 'user' NOT NULL,
	"principal_id" uuid NOT NULL,
	"role" text NOT NULL,
	"added_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_member_org_id_project_id_principal_type_principal_id_pk" PRIMARY KEY("org_id","project_id","principal_type","principal_id"),
	CONSTRAINT "project_member_type_check" CHECK ("app"."project_member"."principal_type" in ('user')),
	CONSTRAINT "project_member_role_check" CHECK ("app"."project_member"."role" in ('manager', 'editor', 'viewer'))
);
--> statement-breakpoint
ALTER TABLE "app"."project_member" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."thread" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."project" ADD CONSTRAINT "project_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."project" ADD CONSTRAINT "project_org_id_parent_id_project_org_id_id_fk" FOREIGN KEY ("org_id","parent_id") REFERENCES "app"."project"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."project_member" ADD CONSTRAINT "project_member_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."project_member" ADD CONSTRAINT "project_member_org_id_project_id_project_org_id_id_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "app"."project"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_member_principal_idx" ON "app"."project_member" USING btree ("org_id","principal_id");--> statement-breakpoint
ALTER TABLE "app"."thread" ADD CONSTRAINT "thread_org_id_project_id_project_org_id_id_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "app"."project"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."artifact" ADD CONSTRAINT "artifact_org_id_project_id_project_org_id_id_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "app"."project"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "thread_project_idx" ON "app"."thread" USING btree ("org_id","project_id");--> statement-breakpoint
CREATE INDEX "artifact_project_idx" ON "app"."artifact" USING btree ("org_id","project_id");--> statement-breakpoint
ALTER TABLE "app"."thread" ADD CONSTRAINT "thread_project_visibility_check" CHECK ("app"."thread"."visibility" <> 'project' or "app"."thread"."project_id" is not null);--> statement-breakpoint
ALTER TABLE "app"."artifact" ADD CONSTRAINT "artifact_project_visibility_check" CHECK ("app"."artifact"."visibility" <> 'project' or "app"."artifact"."project_id" is not null);--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."project" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."project" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."project_member" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."project_member" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);
CREATE TABLE "app"."context_item" (
	"org_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"kind" text NOT NULL,
	"scope" text DEFAULT 'org' NOT NULL,
	"scope_id" uuid,
	"anchor_type" text DEFAULT 'none' NOT NULL,
	"anchor_id" uuid,
	"connection_id" uuid,
	"path" text NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"owner_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"current_version" integer NOT NULL,
	"released_version" integer,
	"verified_by" uuid,
	"verified_at" timestamp with time zone,
	"draft" jsonb,
	"trust" numeric,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "context_item_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "context_item_kind_check" CHECK ("app"."context_item"."kind" in ('dataset', 'metric', 'guide', 'term', 'verified_query', 'skill', 'memory', 'goal', 'doc')),
	CONSTRAINT "context_item_scope_check" CHECK ("app"."context_item"."scope" in ('org', 'project', 'team', 'personal')),
	CONSTRAINT "context_item_anchor_check" CHECK ("app"."context_item"."anchor_type" in ('none', 'connection', 'schema', 'table', 'column', 'dataset', 'metric', 'routine', 'artifact')),
	CONSTRAINT "context_item_status_check" CHECK ("app"."context_item"."status" in ('draft', 'proposed', 'verified', 'needs_review', 'deprecated'))
);
--> statement-breakpoint
ALTER TABLE "app"."context_item" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."context_item_version" (
	"org_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"body" text NOT NULL,
	"body_hash" text NOT NULL,
	"spec" jsonb NOT NULL,
	"derived" jsonb,
	"source" text NOT NULL,
	"author_id" uuid,
	"change_note" text,
	"proposal_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "context_item_version_org_id_item_id_version_pk" PRIMARY KEY("org_id","item_id","version"),
	CONSTRAINT "context_item_version_source_check" CHECK ("app"."context_item_version"."source" in ('user', 'agent', 'proposal', 'import', 'doc_sync', 'miner', 'modeler', 'pack'))
);
--> statement-breakpoint
ALTER TABLE "app"."context_item_version" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."context_item" ADD CONSTRAINT "context_item_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."context_item" ADD CONSTRAINT "context_item_org_id_connection_id_connection_org_id_id_fk" FOREIGN KEY ("org_id","connection_id") REFERENCES "app"."connection"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."context_item_version" ADD CONSTRAINT "context_item_version_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."context_item_version" ADD CONSTRAINT "context_item_version_org_id_item_id_context_item_org_id_id_fk" FOREIGN KEY ("org_id","item_id") REFERENCES "app"."context_item"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "context_item_slug_uq" ON "app"."context_item" USING btree ("org_id","kind",coalesce("connection_id", '00000000-0000-0000-0000-000000000000'::uuid),"scope",coalesce("scope_id", '00000000-0000-0000-0000-000000000000'::uuid),"slug") WHERE "app"."context_item"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "context_item_path_uq" ON "app"."context_item" USING btree ("org_id","path") WHERE "app"."context_item"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "context_item_connection_idx" ON "app"."context_item" USING btree ("org_id","connection_id","kind");--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."context_item" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id()) and (scope <> 'personal' or scope_id = (select app.user_id()))) WITH CHECK (org_id = (select app.org_id()) and (scope <> 'personal' or scope_id = (select app.user_id())));--> statement-breakpoint
CREATE POLICY "system" ON "app"."context_item" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."context_item_version" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."context_item_version" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);
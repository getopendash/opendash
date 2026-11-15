CREATE TABLE "app"."outcome" (
	"org_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"todo_id" uuid NOT NULL,
	"check_no" integer NOT NULL,
	"baseline" double precision,
	"observed" double precision,
	"counterfactual" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"delta" double precision,
	"query_run_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"verdict" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outcome_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "outcome_verdict_check" CHECK ("app"."outcome"."verdict" in ('improved', 'no_change', 'worsened', 'inconclusive'))
);
--> statement-breakpoint
ALTER TABLE "app"."outcome" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."todo" (
	"org_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"insight_id" uuid,
	"metric_id" uuid,
	"connection_id" uuid,
	"title" text NOT NULL,
	"why_now" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expected_impact" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"owner_id" uuid,
	"created_by" uuid,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'accepted' NOT NULL,
	"due_at" date,
	"done_at" timestamp with time zone,
	"check_at" timestamp with time zone,
	"check_spec" jsonb,
	"check_no" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "todo_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "todo_status_check" CHECK ("app"."todo"."status" in ('proposed', 'accepted', 'in_progress', 'done', 'dismissed', 'expired'))
);
--> statement-breakpoint
ALTER TABLE "app"."todo" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."outcome" ADD CONSTRAINT "outcome_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."todo" ADD CONSTRAINT "todo_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "outcome_todo_uq" ON "app"."outcome" USING btree ("org_id","todo_id","check_no");--> statement-breakpoint
CREATE INDEX "todo_check_idx" ON "app"."todo" USING btree ("check_at") WHERE "app"."todo"."check_at" is not null and "app"."todo"."status" = 'done';--> statement-breakpoint
CREATE INDEX "todo_list_idx" ON "app"."todo" USING btree ("org_id","status","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "todo_insight_idx" ON "app"."todo" USING btree ("org_id","insight_id");--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."outcome" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."outcome" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."todo" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."todo" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);--> statement-breakpoint
-- A task's outcome check runs its metric's query as the task, so a query run can be requested by one.
alter table app.query_run drop constraint query_run_requester_type_check;--> statement-breakpoint
alter table app.query_run add constraint query_run_requester_type_check
  check (requester_type in ('run', 'artifact', 'check', 'eval', 'api', 'mcp', 'definition', 'task'));

CREATE TABLE "app"."feedback" (
	"org_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"claim_key" text DEFAULT '' NOT NULL,
	"run_id" uuid,
	"user_id" uuid,
	"kind" text NOT NULL,
	"reason_code" text,
	"comment" text,
	"correction" jsonb,
	"status" text DEFAULT 'new' NOT NULL,
	"route" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "feedback_target_check" CHECK ("app"."feedback"."target_type" in ('run', 'message', 'artifact_version', 'insight', 'todo', 'query_run', 'context_item', 'decision')),
	CONSTRAINT "feedback_kind_check" CHECK ("app"."feedback"."kind" in ('up', 'down', 'wrong_number', 'wrong_definition', 'missing_context', 'correction', 'dismiss', 'edit')),
	CONSTRAINT "feedback_status_check" CHECK ("app"."feedback"."status" in ('new', 'routed', 'ignored')),
	CONSTRAINT "feedback_route_check" CHECK ("app"."feedback"."route" is null or "app"."feedback"."route" in ('personal', 'proposal', 'verified_candidate', 'eval_case', 'routine', 'discard'))
);
--> statement-breakpoint
ALTER TABLE "app"."feedback" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."feedback" ADD CONSTRAINT "feedback_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_one_per_target_uq" ON "app"."feedback" USING btree ("org_id","user_id","target_type","target_id","claim_key");--> statement-breakpoint
CREATE INDEX "feedback_status_idx" ON "app"."feedback" USING btree ("org_id","status","created_at");--> statement-breakpoint
CREATE INDEX "feedback_run_idx" ON "app"."feedback" USING btree ("org_id","run_id");--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."feedback" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."feedback" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);
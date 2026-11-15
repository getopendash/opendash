CREATE TABLE "app"."proposal" (
	"org_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"kind" text DEFAULT 'create' NOT NULL,
	"source" text DEFAULT 'modeler' NOT NULL,
	"status" text DEFAULT 'drafting' NOT NULL,
	"run_id" uuid,
	"requested_by" uuid,
	"from_query_run_id" uuid,
	"from_artifact_id" uuid,
	"from_query_id" text,
	"title" text NOT NULL,
	"rationale" text,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"items" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"held_reason" text,
	"reviewer_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "proposal_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "proposal_kind_check" CHECK ("app"."proposal"."kind" in ('create')),
	CONSTRAINT "proposal_source_check" CHECK ("app"."proposal"."source" in ('modeler')),
	CONSTRAINT "proposal_status_check" CHECK ("app"."proposal"."status" in ('drafting', 'held', 'failed', 'open', 'approved', 'rejected', 'superseded'))
);
--> statement-breakpoint
ALTER TABLE "app"."proposal" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."run" DROP CONSTRAINT "run_profile_check";--> statement-breakpoint
ALTER TABLE "app"."proposal" ADD CONSTRAINT "proposal_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "proposal_query_live_uq" ON "app"."proposal" USING btree ("org_id","from_query_run_id") WHERE "app"."proposal"."status" in ('drafting', 'open');--> statement-breakpoint
CREATE INDEX "proposal_review_idx" ON "app"."proposal" USING btree ("org_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "proposal_artifact_idx" ON "app"."proposal" USING btree ("org_id","from_artifact_id");--> statement-breakpoint
ALTER TABLE "app"."run" ADD CONSTRAINT "run_profile_check" CHECK ("app"."run"."profile" in ('analyst', 'investigator', 'reviewer', 'modeler'));--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."proposal" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."proposal" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);
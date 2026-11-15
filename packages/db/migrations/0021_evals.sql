CREATE TABLE "app"."eval_case" (
	"org_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"suite_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"question" text NOT NULL,
	"phrasings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"question_hash" text NOT NULL,
	"as_of" timestamp with time zone,
	"persona" text,
	"reference_spec" jsonb,
	"reference_sql" text,
	"compare" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expect_clarification" boolean DEFAULT false NOT NULL,
	"expect_refusal" boolean DEFAULT false NOT NULL,
	"category" text,
	"split" text DEFAULT 'dev' NOT NULL,
	"origin" text NOT NULL,
	"origin_ref" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "eval_case_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "eval_case_split_check" CHECK ("app"."eval_case"."split" in ('dev', 'holdout')),
	CONSTRAINT "eval_case_origin_check" CHECK ("app"."eval_case"."origin" in ('benchmark', 'onboarding', 'correction', 'admin')),
	CONSTRAINT "eval_case_reference_check" CHECK ("app"."eval_case"."reference_spec" is not null or "app"."eval_case"."reference_sql" is not null)
);
--> statement-breakpoint
ALTER TABLE "app"."eval_case" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."eval_result" (
	"org_id" uuid NOT NULL,
	"eval_run_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"phrasing_idx" integer DEFAULT 0 NOT NULL,
	"run_id" uuid,
	"agent_qr_id" uuid,
	"reference_qr_id" uuid,
	"verdict" text NOT NULL,
	"diff" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "eval_result_org_id_eval_run_id_case_id_attempt_phrasing_idx_pk" PRIMARY KEY("org_id","eval_run_id","case_id","attempt","phrasing_idx"),
	CONSTRAINT "eval_result_verdict_check" CHECK ("app"."eval_result"."verdict" in ('pass', 'fail', 'error', 'clarified_ok', 'refused_ok'))
);
--> statement-breakpoint
ALTER TABLE "app"."eval_result" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."eval_run" (
	"org_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"suite_id" uuid NOT NULL,
	"context_release_id" uuid,
	"candidate_release_id" uuid,
	"baseline_run_id" uuid,
	"model" text NOT NULL,
	"trigger" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"case_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"requested_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "eval_run_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "eval_run_trigger_check" CHECK ("app"."eval_run"."trigger" in ('proposal', 'release', 'schedule', 'manual', 'ci')),
	CONSTRAINT "eval_run_status_check" CHECK ("app"."eval_run"."status" in ('queued', 'running', 'done', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "app"."eval_run" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."eval_suite" (
	"org_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"name" text NOT NULL,
	"scope" text DEFAULT 'org' NOT NULL,
	"gate" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"owner_id" uuid,
	"nightly" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "eval_suite_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "eval_suite_scope_check" CHECK ("app"."eval_suite"."scope" in ('global', 'org'))
);
--> statement-breakpoint
ALTER TABLE "app"."eval_suite" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."eval_case" ADD CONSTRAINT "eval_case_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."eval_case" ADD CONSTRAINT "eval_case_org_id_suite_id_eval_suite_org_id_id_fk" FOREIGN KEY ("org_id","suite_id") REFERENCES "app"."eval_suite"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."eval_result" ADD CONSTRAINT "eval_result_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."eval_result" ADD CONSTRAINT "eval_result_org_id_eval_run_id_eval_run_org_id_id_fk" FOREIGN KEY ("org_id","eval_run_id") REFERENCES "app"."eval_run"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."eval_result" ADD CONSTRAINT "eval_result_org_id_case_id_eval_case_org_id_id_fk" FOREIGN KEY ("org_id","case_id") REFERENCES "app"."eval_case"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."eval_run" ADD CONSTRAINT "eval_run_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."eval_run" ADD CONSTRAINT "eval_run_org_id_suite_id_eval_suite_org_id_id_fk" FOREIGN KEY ("org_id","suite_id") REFERENCES "app"."eval_suite"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."eval_suite" ADD CONSTRAINT "eval_suite_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "eval_case_question_uq" ON "app"."eval_case" USING btree ("org_id","suite_id","question_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "eval_run_active_uq" ON "app"."eval_run" USING btree ("org_id","suite_id") WHERE "app"."eval_run"."status" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "eval_run_suite_idx" ON "app"."eval_run" USING btree ("org_id","suite_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "eval_suite_org_uq" ON "app"."eval_suite" USING btree ("org_id") WHERE "app"."eval_suite"."scope" = 'org';--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."eval_case" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."eval_case" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."eval_result" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."eval_result" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."eval_run" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."eval_run" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."eval_suite" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."eval_suite" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);
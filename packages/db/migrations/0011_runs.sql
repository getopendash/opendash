CREATE TABLE "app"."message" (
	"org_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"run_id" uuid,
	"seq" integer,
	"role" text NOT NULL,
	"kind" text DEFAULT 'normal' NOT NULL,
	"author_id" uuid,
	"client_msg_id" text,
	"content" jsonb NOT NULL,
	"text" text,
	"usage" jsonb,
	"model" text,
	"stop_reason" text,
	"status" text DEFAULT 'complete' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "message_role_check" CHECK ("app"."message"."role" in ('user', 'assistant', 'tool_result', 'system_note')),
	CONSTRAINT "message_kind_check" CHECK ("app"."message"."kind" in ('normal', 'compaction', 'queued_input')),
	CONSTRAINT "message_status_check" CHECK ("app"."message"."status" in ('queued', 'complete', 'interrupted'))
);
--> statement-breakpoint
ALTER TABLE "app"."message" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."run" (
	"org_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"parent_run_id" uuid,
	"trigger" text DEFAULT 'user' NOT NULL,
	"input_message_id" uuid,
	"profile" text DEFAULT 'analyst' NOT NULL,
	"model" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"worker_id" text,
	"attempt_started_at" timestamp with time zone,
	"cancel_requested_at" timestamp with time zone,
	"usage" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_event_seq" integer DEFAULT 0 NOT NULL,
	"outcome" jsonb,
	"error" text,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "run_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "run_trigger_check" CHECK ("app"."run"."trigger" in ('user', 'api', 'eval')),
	CONSTRAINT "run_profile_check" CHECK ("app"."run"."profile" in ('analyst')),
	CONSTRAINT "run_status_check" CHECK ("app"."run"."status" in ('queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "app"."run" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."thread" (
	"org_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"created_by" uuid,
	"title" text NOT NULL,
	"channel" text DEFAULT 'web' NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"msg_seq" integer DEFAULT 0 NOT NULL,
	"query_seq" integer DEFAULT 0 NOT NULL,
	"last_message_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "thread_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "thread_channel_check" CHECK ("app"."thread"."channel" in ('web', 'api', 'eval')),
	CONSTRAINT "thread_visibility_check" CHECK ("app"."thread"."visibility" in ('private', 'project', 'org'))
);
--> statement-breakpoint
ALTER TABLE "app"."thread" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."tool_call" (
	"org_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"message_id" uuid,
	"call_id" text NOT NULL,
	"tool" text NOT NULL,
	"args" jsonb NOT NULL,
	"effect_class" text DEFAULT 'read' NOT NULL,
	"status" text DEFAULT 'started' NOT NULL,
	"attempt" integer NOT NULL,
	"result" jsonb,
	"query_run_id" uuid,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "tool_call_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "tool_call_effect_class_check" CHECK ("app"."tool_call"."effect_class" in ('read', 'compute', 'internal', 'external')),
	CONSTRAINT "tool_call_status_check" CHECK ("app"."tool_call"."status" in ('started', 'succeeded', 'failed', 'cancelled', 'unknown'))
);
--> statement-breakpoint
ALTER TABLE "app"."tool_call" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."message" ADD CONSTRAINT "message_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."message" ADD CONSTRAINT "message_org_id_thread_id_thread_org_id_id_fk" FOREIGN KEY ("org_id","thread_id") REFERENCES "app"."thread"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."run" ADD CONSTRAINT "run_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."run" ADD CONSTRAINT "run_org_id_thread_id_thread_org_id_id_fk" FOREIGN KEY ("org_id","thread_id") REFERENCES "app"."thread"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."thread" ADD CONSTRAINT "thread_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."thread" ADD CONSTRAINT "thread_org_id_connection_id_connection_org_id_id_fk" FOREIGN KEY ("org_id","connection_id") REFERENCES "app"."connection"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."tool_call" ADD CONSTRAINT "tool_call_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."tool_call" ADD CONSTRAINT "tool_call_org_id_run_id_run_org_id_id_fk" FOREIGN KEY ("org_id","run_id") REFERENCES "app"."run"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "message_seq_uq" ON "app"."message" USING btree ("org_id","thread_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "message_client_msg_uq" ON "app"."message" USING btree ("org_id","thread_id","client_msg_id") WHERE "app"."message"."client_msg_id" is not null;--> statement-breakpoint
CREATE INDEX "message_run_idx" ON "app"."message" USING btree ("org_id","run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "run_active_uq" ON "app"."run" USING btree ("org_id","thread_id") WHERE "app"."run"."parent_run_id" is null and "app"."run"."status" in ('queued', 'running', 'cancelling');--> statement-breakpoint
CREATE INDEX "run_thread_idx" ON "app"."run" USING btree ("org_id","thread_id","queued_at");--> statement-breakpoint
CREATE INDEX "run_running_idx" ON "app"."run" USING btree ("attempt_started_at") WHERE "app"."run"."status" = 'running';--> statement-breakpoint
CREATE INDEX "thread_created_by_idx" ON "app"."thread" USING btree ("org_id","created_by","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_call_call_uq" ON "app"."tool_call" USING btree ("org_id","run_id","call_id");--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."message" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."message" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."run" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."run" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."thread" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."thread" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."tool_call" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."tool_call" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);
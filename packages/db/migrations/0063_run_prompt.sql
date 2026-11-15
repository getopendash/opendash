-- What each run was sent: prompt layers stored once by hash, the latest attempt's prompt on the run, and
-- how each attempt ended. Additive.
CREATE TABLE "app"."prompt_text" (
	"org_id" uuid NOT NULL,
	"sha256" text NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prompt_text_org_id_sha256_pk" PRIMARY KEY("org_id","sha256")
);
--> statement-breakpoint
ALTER TABLE "app"."prompt_text" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."run" ADD COLUMN "prompt" jsonb;--> statement-breakpoint
ALTER TABLE "app"."run" ADD COLUMN "attempts" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."prompt_text" ADD CONSTRAINT "prompt_text_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."prompt_text" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."prompt_text" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);
-- The context graph's first slice: node and edge, projected per organization from canonical rows by
-- graph.project and rebuilt whole (current state only; personal memories stay out), and a GIN index on what each
-- query read (query_run.reads), so "which answers read this table" is a lookup, never an edge per answer.
CREATE TABLE "app"."edge" (
	"org_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"rel" text NOT NULL,
	"src_id" uuid NOT NULL,
	"dst_id" uuid NOT NULL,
	"props" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "edge_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "edge_rel_check" CHECK ("app"."edge"."rel" in ('MEANS', 'IS_NOT', 'ABOUT', 'SAID_BY', 'PART_OF', 'DEFINED_ON', 'MEASURES'))
);
--> statement-breakpoint
ALTER TABLE "app"."edge" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."node" (
	"org_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"title" text,
	"status" text,
	"connection_id" uuid,
	"props" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"projected_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "node_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "node_kind_check" CHECK ("app"."node"."kind" in ('table', 'column', 'dataset', 'metric', 'term', 'guide', 'learning', 'person'))
);
--> statement-breakpoint
ALTER TABLE "app"."node" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."edge" ADD CONSTRAINT "edge_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."edge" ADD CONSTRAINT "edge_org_id_src_id_node_org_id_id_fk" FOREIGN KEY ("org_id","src_id") REFERENCES "app"."node"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."edge" ADD CONSTRAINT "edge_org_id_dst_id_node_org_id_id_fk" FOREIGN KEY ("org_id","dst_id") REFERENCES "app"."node"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."node" ADD CONSTRAINT "node_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "edge_src_rel_dst_uq" ON "app"."edge" USING btree ("org_id","src_id","rel","dst_id");--> statement-breakpoint
CREATE INDEX "edge_dst_rel_idx" ON "app"."edge" USING btree ("org_id","dst_id","rel");--> statement-breakpoint
CREATE INDEX "node_kind_key_idx" ON "app"."node" USING btree ("org_id","kind","key");--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."edge" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."edge" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."node" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."node" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE INDEX "query_run_reads_gin" ON "app"."query_run" USING gin ("reads" jsonb_path_ops);

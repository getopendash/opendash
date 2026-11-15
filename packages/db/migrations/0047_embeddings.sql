CREATE TABLE "app"."embedding" (
	"org_id" uuid NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"model" text NOT NULL,
	"content_hash" text NOT NULL,
	"vector" halfvec(1024) NOT NULL,
	"embedded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "embedding_org_id_subject_kind_subject_id_pk" PRIMARY KEY("org_id","subject_kind","subject_id"),
	CONSTRAINT "embedding_subject_kind_check" CHECK ("app"."embedding"."subject_kind" in ('context_item', 'catalog_object'))
);
--> statement-breakpoint
ALTER TABLE "app"."embedding" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."embedding_state" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"model" text NOT NULL,
	"checked_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."embedding_state" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."embedding" ADD CONSTRAINT "embedding_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."embedding_state" ADD CONSTRAINT "embedding_state_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."embedding" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."embedding" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "tenant" ON "app"."embedding_state" AS PERMISSIVE FOR ALL TO "opendash_app" USING (org_id = (select app.org_id())) WITH CHECK (org_id = (select app.org_id()));--> statement-breakpoint
CREATE POLICY "system" ON "app"."embedding_state" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);--> statement-breakpoint
-- Vectors: the subjects nearest a query's vector, by an exact scan of the organization's rows (up to
-- 50k vectors), joined to what's released and live now (released knowledge of organization scope, never memory; a
-- live source's tables), with this model only, at or above the similarity floor. SECURITY DEFINER because pgvector's
-- operators aren't leakproof under RLS (as search_context); it filters on app.org_id() inside and takes no org id.
-- `p_connection` keeps a source's own subjects and the organization's unscoped knowledge, as the analyst's search
-- does; null keeps every source's.
create function app.search_vectors(
  p_vector public.halfvec(1024), p_model text, p_kinds text[], p_connection uuid, p_min real, p_limit int
)
  returns table (kind text, id uuid, connection_id uuid, title text, key text, status text, similarity real)
  language sql stable security definer
  set search_path = app, pg_catalog, pg_temp
  as $$
    with nearest as (
      select e.subject_kind, e.subject_id, (1 - (e.vector operator(public.<=>) p_vector))::real as similarity
      from embedding e
      where e.org_id = app.org_id() and e.model = p_model
    )
    select * from (
      select i.kind, i.id, i.connection_id, i.title, i.slug as key, i.status, n.similarity
      from nearest n
      join context_item i on i.org_id = app.org_id() and i.id = n.subject_id
      where n.subject_kind = 'context_item' and i.deleted_at is null and i.released_version is not null
        and i.scope = 'org' and i.kind = any(p_kinds)
        and i.kind in ('dataset', 'metric', 'guide', 'term', 'verified_query', 'skill')
        and (p_connection is null or i.connection_id is null or i.connection_id = p_connection)
      union all
      select 'table', o.id, o.connection_id, o.fq_name, o.fq_name, 'observed', n.similarity
      from nearest n
      join catalog_object o on o.org_id = app.org_id() and o.id = n.subject_id
      join connection c on c.org_id = o.org_id and c.id = o.connection_id and c.deleted_at is null
      where n.subject_kind = 'catalog_object' and 'table' = any(p_kinds) and o.kind in ('table', 'view')
        and o.removed_at is null and (p_connection is null or o.connection_id = p_connection)
    ) found
    where found.similarity >= p_min
    order by found.similarity desc, found.id
    limit least(greatest(p_limit, 1), 100)
  $$;
--> statement-breakpoint
revoke all on function app.search_vectors(public.halfvec, text, text[], uuid, real, int) from public;
--> statement-breakpoint
grant execute on function app.search_vectors(public.halfvec, text, text[], uuid, real, int) to opendash_app;

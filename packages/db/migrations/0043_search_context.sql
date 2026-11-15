-- Search v0 (retrieval v1, its lexical half): the workspace's released knowledge (datasets, metrics,
-- glossary terms, guides, verified queries, skills; organization scope only, never memory) and its sources' tables,
-- ranked on the fly by full text and by trigram word similarity. SECURITY DEFINER because those operators aren't
-- leakproof under RLS; it filters on app.org_id() inside and takes no org id. No limit inside (0030's lesson): the
-- caller fuses, weighs and caps. pg_trgm lives in public: its calls are qualified, so search_path stays pinned. The
-- context graph's node index replaces the on-the-fly vectors later.
create function app.search_context(q text, kinds text[])
  returns table (kind text, id uuid, connection_id uuid, title text, key text, status text, fts real, sim real, exact boolean)
  language sql stable security definer
  set search_path = app, pg_catalog, pg_temp
  as $$
    with query as (
      select websearch_to_tsquery('simple', q) as tsq, lower(btrim(q)) as lq
    ),
    items as (
      select i.kind, i.id, i.connection_id, i.title, i.slug as key, i.status,
        concat_ws(' ', i.title, translate(i.slug, '_-', '  '), v.spec->>'label', v.spec->>'description', v.spec->>'means',
          v.spec->>'term', v.spec->>'question', v.spec->>'use_when', left(v.spec->>'body', 4000),
          (select string_agg(s, ' ') from jsonb_array_elements_text(
            case when jsonb_typeof(v.spec->'synonyms') = 'array' then v.spec->'synonyms' else '[]'::jsonb end) s),
          (select string_agg(s, ' ') from jsonb_array_elements_text(
            case when jsonb_typeof(v.spec->'phrasings') = 'array' then v.spec->'phrasings' else '[]'::jsonb end) s)
        ) as doc,
        array_remove(array[lower(i.title), lower(i.slug), lower(v.spec->>'term')]
          || array(select lower(s) from jsonb_array_elements_text(
            case when jsonb_typeof(v.spec->'synonyms') = 'array' then v.spec->'synonyms' else '[]'::jsonb end) s), null)
          as names
      from context_item i
      join context_item_version v on v.org_id = i.org_id and v.item_id = i.id and v.version = i.released_version
      where i.org_id = app.org_id() and i.deleted_at is null and i.released_version is not null and i.scope = 'org'
        and i.kind = any(kinds) and i.kind in ('dataset', 'metric', 'guide', 'term', 'verified_query', 'skill')
    ),
    tables as (
      select 'table'::text as kind, o.id, o.connection_id, o.fq_name as title, o.fq_name as key, 'observed'::text as status,
        concat_ws(' ', translate(o.fq_name, '._', '  '), o.comment) as doc,
        array[lower(o.fq_name), lower(o.name)] as names
      from catalog_object o
      join connection c on c.org_id = o.org_id and c.id = o.connection_id and c.deleted_at is null
      where o.org_id = app.org_id() and o.kind in ('table', 'view') and o.removed_at is null and 'table' = any(kinds)
    ),
    candidates as (select * from items union all select * from tables)
    select c.kind, c.id, c.connection_id, c.title, c.key, c.status,
      ts_rank_cd(to_tsvector('simple', c.doc), query.tsq)::real as fts,
      greatest(public.word_similarity(query.lq, lower(c.title)),
        coalesce((select max(public.word_similarity(query.lq, n)) from unnest(c.names) n), 0))::real as sim,
      query.lq = any(c.names) as exact
    from candidates c, query
    where query.lq <> '' and (
      to_tsvector('simple', c.doc) @@ query.tsq
      or query.lq operator(public.<%) lower(c.title)
      or exists (select 1 from unnest(c.names) n where query.lq operator(public.<%) n))
  $$;
--> statement-breakpoint
revoke all on function app.search_context(text, text[]) from public;
--> statement-breakpoint
grant execute on function app.search_context(text, text[]) to opendash_app;

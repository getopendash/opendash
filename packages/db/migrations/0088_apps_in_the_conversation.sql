ALTER TABLE "app"."app_draft" ADD COLUMN "plan" jsonb;--> statement-breakpoint
ALTER TABLE "app"."app_draft" ADD COLUMN "preview_bundle" text;--> statement-breakpoint
ALTER TABLE "app"."app_draft" ADD COLUMN "preview_hash" text;--> statement-breakpoint
ALTER TABLE "app"."app_draft" ADD COLUMN "preview_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "app_draft_preview_idx" ON "app"."app_draft" USING btree ("preview_hash");--> statement-breakpoint
-- A bundle by its hash for the Apps origin: a saved version's (anyone the page lets open the App), or a draft's live
-- preview (only its owner's page signs a link to it). Code, never data: an App's data comes through the page
-- around it, checked there. Nothing of a deleted App.
create or replace function app.app_bundle(p_hash text) returns text
  language sql stable security definer
  set search_path = pg_catalog, pg_temp
  as $$
    select bundle from (
      select b.bundle from app.app_build b
      join app.artifact a on a.org_id = b.org_id and a.id = b.artifact_id
      where b.bundle_hash = p_hash and a.deleted_at is null and a.kind = 'app'
      union all
      select d.preview_bundle from app.app_draft d
      join app.artifact a on a.org_id = d.org_id and a.id = d.artifact_id
      where d.preview_hash = p_hash and d.preview_bundle is not null and a.deleted_at is null and a.kind = 'app'
    ) found
    limit 1
  $$;

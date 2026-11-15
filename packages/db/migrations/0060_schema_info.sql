-- How each known table or view is built (engine, keys, a view's cleaned definition and what it reads).
ALTER TABLE "app"."catalog_object" ADD COLUMN "schema_info" jsonb DEFAULT '{}'::jsonb NOT NULL;
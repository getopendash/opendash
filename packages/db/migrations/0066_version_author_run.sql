-- The drafter that wrote a definition's version: each drafter repairs only its own. Additive.
ALTER TABLE "app"."context_item_version" ADD COLUMN "author_run_id" uuid;
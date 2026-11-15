-- A source's tables are known, or learned (picked by its admin). The sources connected before learn every
-- table they learned, as chosen when they were connected.
ALTER TABLE "app"."connection" ADD COLUMN "learning_chosen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."connection" ADD COLUMN "learning_chosen_by" uuid;--> statement-breakpoint
ALTER TABLE "app"."catalog_object" ADD COLUMN "learn" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "app"."catalog_object" SET "learn" = true WHERE "kind" IN ('table', 'view');--> statement-breakpoint
UPDATE "app"."connection" SET "learning_chosen_at" = "created_at";

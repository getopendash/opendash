-- A learning run's attempts (the ClickHouse indexing fix): a stalled delivery that was retried can't write over the
-- delivery that replaced it.
ALTER TABLE "app"."sync_run" ADD COLUMN "attempt" integer DEFAULT 0 NOT NULL;
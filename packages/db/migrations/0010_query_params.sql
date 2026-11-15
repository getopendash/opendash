-- Query parameters: values for $1, $2…, bound by the
-- source database, never pasted into the SQL. Kept with their names, so the same query can run again with other
-- values (interpretation chips, dashboard filters) without the model. sql_hash stays the hash of the SQL text alone.
alter table app.query_run add column params jsonb;

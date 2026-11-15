-- Checking a definition against the source (does the dataset run, is its grain unique, do its joins hold) runs
-- queries like any other, and each leaves a query_run, requested by the definition (requester_id: the item).
alter table app.query_run drop constraint query_run_requester_type_check;
--> statement-breakpoint
alter table app.query_run add constraint query_run_requester_type_check
  check (requester_type in ('run', 'artifact', 'check', 'eval', 'api', 'mcp', 'definition'));

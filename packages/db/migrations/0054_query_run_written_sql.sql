-- Readable SQL on a query card (the warehouse review): ClickHouse runs the server's one-line canonical form of a
-- statement, without its comments or line breaks. The text as the analyst wrote it is kept beside it, for reading.
alter table app.query_run add column written_sql text;

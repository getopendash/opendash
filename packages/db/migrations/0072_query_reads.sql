-- What each statement read: its tables, as the catalog names them, and the values it compared columns
-- with, from the gateway's own parse. A learning's test grades the answer's queries on it ("must read
-- subscriptions with status = 'active', never trial_accounts"); the context graph's "used" edges come
-- from it later. Nothing new is copied: the same tables and literals are in the statement already kept beside it.
alter table app.query_run add column reads jsonb;

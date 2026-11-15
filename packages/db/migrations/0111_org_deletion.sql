CREATE TABLE "app"."org_deletion" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"purged_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "app"."org_deletion" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."org" DROP CONSTRAINT "org_id_organization_id_fk";
--> statement-breakpoint
CREATE INDEX "org_deletion_unpurged_idx" ON "app"."org_deletion" USING btree ("deleted_at") WHERE "app"."org_deletion"."purged_at" is null;--> statement-breakpoint
ALTER TABLE "app"."org" ADD CONSTRAINT "org_id_organization_id_fk" FOREIGN KEY ("id") REFERENCES "auth"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "system" ON "app"."org_deletion" AS PERMISSIVE FOR ALL TO "opendash_system" USING (true) WITH CHECK (true);--> statement-breakpoint
-- Every deletion of an organization leaves its record, in the same transaction, whoever deletes it (the auth role,
-- through the foreign key above): the worker purges from it what no foreign key reaches. SECURITY DEFINER because
-- the row is the system's alone; it takes nothing from its caller but the deleted row's id.
create function app.org_deleted() returns trigger
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $$
    begin
      insert into app.org_deletion (org_id) values (old.id) on conflict (org_id) do nothing;
      return old;
    end
  $$;
--> statement-breakpoint
revoke all on function app.org_deleted() from public;
--> statement-breakpoint
create trigger org_deleted after delete on app.org
  for each row execute function app.org_deleted();
--> statement-breakpoint
-- A secret that only its row points at goes with the row (0086). When the row goes by a foreign key's cascade from
-- another role's delete (the auth role deleting an organization), the trigger fires as that role, which has no rights
-- in this schema: so it runs as its owner now. It still deletes only the one secret the deleted row itself names, in
-- that row's own organization.
alter function app.mcp_drop_secret() security definer;
--> statement-breakpoint
revoke all on function app.mcp_drop_secret() from public;
--> statement-breakpoint
-- The audit log of organizations that were deleted: its rows are never deleted otherwise (audit_log_guard), and no
-- foreign key takes them. Removes up to `batch` rows of organizations recorded as deleted, not yet purged and no
-- longer there, and says how many went. It takes no organization from its caller: only the record decides whose rows
-- go. The system's alone.
create function app.purge_deleted_audit_log(batch integer) returns bigint
  language plpgsql security definer
  set search_path = app, pg_temp
  as $$
  declare
    n bigint;
  begin
    perform set_config('app.audit_purge', 'on', true);
    delete from app.audit_log a
      where (a.org_id, a.id) in (
        select l.org_id, l.id from app.audit_log l
        join app.org_deletion d on d.org_id = l.org_id and d.purged_at is null
        where not exists (select 1 from app.org o where o.id = l.org_id)
        limit greatest(batch, 0));
    get diagnostics n = row_count;
    perform set_config('app.audit_purge', 'off', true);
    return n;
  end $$;
--> statement-breakpoint
revoke all on function app.purge_deleted_audit_log(integer) from public;
--> statement-breakpoint
grant execute on function app.purge_deleted_audit_log(integer) to opendash_system;

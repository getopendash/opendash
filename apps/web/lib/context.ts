import "server-only";
import { type ContextKind, getContextItem, listContext } from "@opendash/core";
import { sql, withTenant } from "@opendash/db";

/** The glossary or the guides. */
export const contextListFor = (orgId: string, kind: ContextKind) =>
  withTenant({ orgId }, (tx) => listContext(tx, orgId, kind));

/** A term or guide, with the sources a mapping or an anchor can name. */
export async function contextItemFor(orgId: string, id: string) {
  return withTenant({ orgId }, (tx) => getContextItem(tx, orgId, id));
}

/** The sources a term can map to, or a guide can apply to. */
export const sourcesFor = (orgId: string) =>
  withTenant({ orgId }, (tx) =>
    tx.execute<{ id: string; name: string }>(sql`
      select id, name from app.connection where org_id = ${orgId} and deleted_at is null order by name`),
  );

/** The tables a guide can apply to, per source. */
export const tablesFor = (orgId: string) =>
  withTenant({ orgId }, (tx) =>
    tx.execute<{ connection_id: string; fq_name: string }>(sql`
      select connection_id, fq_name from app.catalog_object
      where org_id = ${orgId} and kind in ('table', 'view') and removed_at is null order by fq_name`),
  );

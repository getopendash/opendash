import { sql } from "drizzle-orm";
import { check, halfvec, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { app, org } from "./identity";
import { tenantPolicies } from "./policies";

/**
 * Vectors: one per released knowledge item or source table, of the text the
 * search reads, with that text's hash (embedded again only when it changes) and its model (another model's rows are
 * never compared with this one's). Searched by an exact scan per organization in `app.search_vectors`, joined to
 * what's released and live now, so a row of something gone is never found; the next batch removes it.
 */
export const embedding = app
  .table(
    "embedding",
    {
      orgId: uuid("org_id")
        .notNull()
        .references(() => org.id, { onDelete: "cascade" }),
      /** A knowledge item (`context_item`) or a source's table (`catalog_object`). */
      subjectKind: text("subject_kind").notNull(),
      subjectId: uuid("subject_id").notNull(),
      model: text("model").notNull(),
      contentHash: text("content_hash").notNull(),
      vector: halfvec("vector", { dimensions: 1024 }).notNull(),
      embeddedAt: timestamp("embedded_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      primaryKey({ columns: [t.orgId, t.subjectKind, t.subjectId] }),
      check("embedding_subject_kind_check", sql`${t.subjectKind} in ('context_item', 'catalog_object')`),
      ...tenantPolicies(),
    ],
  )
  .enableRLS();

/** When an organization's knowledge and tables were last embedded, and with which model: what the tick compares. */
export const embeddingState = app
  .table(
    "embedding_state",
    {
      orgId: uuid("org_id")
        .primaryKey()
        .references(() => org.id, { onDelete: "cascade" }),
      model: text("model").notNull(),
      /** The batch's start: a change made while it ran is picked up by the next one. */
      checkedAt: timestamp("checked_at", { withTimezone: true }).notNull(),
    },
    () => [...tenantPolicies()],
  )
  .enableRLS();

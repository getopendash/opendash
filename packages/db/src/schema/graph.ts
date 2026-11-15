import { sql } from "drizzle-orm";
import { check, foreignKey, index, jsonb, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { app, org } from "./identity";
import { tenantPolicies } from "./policies";

/**
 * The context graph's first slice: what a workspace's knowledge is connected to,
 * projected from canonical rows by `graph.project` and rebuilt whole, so nothing canonical lives here. Current state
 * only. Personal memories stay out: a topic reads the viewer's own memories where they live, under their own RLS.
 *
 * A node's id is the id of the row it projects (a catalog object, a knowledge item, a learning, a member), so edges
 * and links point at what people already know.
 */
export const node = app
  .table(
    "node",
    {
      orgId: uuid("org_id")
        .notNull()
        .references(() => org.id, { onDelete: "cascade" }),
      id: uuid("id").notNull(),
      /** table · column · dataset · metric · term · guide · learning · person */
      kind: text("kind").notNull(),
      /** How it's found: a table's or column's lowercased name, a term's topic key, a definition's slug. */
      key: text("key").notNull(),
      title: text("title"),
      /** The row's own status (verified, proposed, open…), as projected. */
      status: text("status"),
      connectionId: uuid("connection_id"),
      props: jsonb("props").notNull().default({}),
      projectedAt: timestamp("projected_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      primaryKey({ columns: [t.orgId, t.id] }),
      index("node_kind_key_idx").on(t.orgId, t.kind, t.key),
      check(
        "node_kind_check",
        sql`${t.kind} in ('table', 'column', 'dataset', 'metric', 'term', 'guide', 'learning', 'person')`,
      ),
      ...tenantPolicies(),
    ],
  )
  .enableRLS();

/**
 * An edge between two nodes, projected with them. `MEANS` term → column (`props.values`) or metric; `IS_NOT` term →
 * table; `ABOUT` guide → table, learning → term; `SAID_BY` learning → person (`props.count`); `PART_OF` column →
 * table; `DEFINED_ON` dataset → table; `MEASURES` metric → dataset. "Which answers read X" stays on `query_run.reads`.
 */
export const edge = app
  .table(
    "edge",
    {
      orgId: uuid("org_id")
        .notNull()
        .references(() => org.id, { onDelete: "cascade" }),
      id: uuid("id").notNull(),
      rel: text("rel").notNull(),
      srcId: uuid("src_id").notNull(),
      dstId: uuid("dst_id").notNull(),
      props: jsonb("props").notNull().default({}),
    },
    (t) => [
      primaryKey({ columns: [t.orgId, t.id] }),
      uniqueIndex("edge_src_rel_dst_uq").on(t.orgId, t.srcId, t.rel, t.dstId),
      index("edge_dst_rel_idx").on(t.orgId, t.dstId, t.rel),
      foreignKey({ columns: [t.orgId, t.srcId], foreignColumns: [node.orgId, node.id] }).onDelete("cascade"),
      foreignKey({ columns: [t.orgId, t.dstId], foreignColumns: [node.orgId, node.id] }).onDelete("cascade"),
      check(
        "edge_rel_check",
        sql`${t.rel} in ('MEANS', 'IS_NOT', 'ABOUT', 'SAID_BY', 'PART_OF', 'DEFINED_ON', 'MEASURES')`,
      ),
      ...tenantPolicies(),
    ],
  )
  .enableRLS();

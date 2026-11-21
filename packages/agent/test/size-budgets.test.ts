// What every model call sends before its conversation, held to a budget per agent and database: the
// agent layer (its rules and its database's notes) and its tools (names, descriptions, JSON schemas). Both are sent
// on every call; growing either past its budget fails here, so it grows on purpose: raise the number in the same
// change, saying why. The source layer depends on each source, and is measured on real runs instead.
import { dialectFor } from "@opendash/connectors";
import { zodSchema } from "ai";
import { describe, expect, it } from "vitest";
import { INVESTIGATOR_TOOLS } from "../src";
import { ANALYST_TOOLS } from "../src/agents/analyst";
import { analystSections } from "../src/agents/analyst/prompt";
import { investigatorSections } from "../src/agents/investigator/prompt";
import { MODELER_LEAD_TOOLS, MODELER_SOURCE_TOOLS } from "../src/agents/modeler";
import { DRAFTER_TOOLS } from "../src/agents/modeler/drafter";
import { modelerSections } from "../src/agents/modeler/prompt";
import { compose, type Sections } from "../src/instructions/compose";
import { DASHBOARD_TOOLS } from "../src/tools/dashboards";
import { MCP_TOOLS } from "../src/tools/mcp";
import type { AgentTool } from "../src/tools/types";

type Db = "postgres" | "clickhouse" | "mysql";
const DATABASES: Db[] = ["postgres", "clickhouse", "mysql"];

const common = (db: Db) => {
  const d = dialectFor(db);
  return {
    sourceName: "source",
    dialectName: d.name,
    dialectNotes: d.notes(),
    catalog: "",
    metrics: "- mrr",
    now: new Date("2026-10-15T00:00:00Z"),
    rowsShown: 50,
  };
};
const insight = {
  title: "MRR fell",
  kind: "anomaly",
  direction: "down",
  period: "2026-09-01",
  metricSlug: "mrr",
  metricTitle: "MRR",
};

const MCP_TOOL_NAMES = new Set<string>(MCP_TOOLS.map((t) => t.name));
/** Offered only where connected services are on. */
const notMcp = (t: AgentTool) => !MCP_TOOL_NAMES.has(t.name);
const DASHBOARD_TOOL_NAMES = new Set<string>(DASHBOARD_TOOLS.map((t) => t.name));
const notDashboards = (t: AgentTool) => !DASHBOARD_TOOL_NAMES.has(t.name);
const AGENTS: Record<string, { sections: (db: Db) => Sections; tools: AgentTool[] }> = {
  analyst: {
    sections: (db) => analystSections(common(db)),
    // definition_draft goes only with a metric or dataset attached that's the asker's to change.
    tools: ANALYST_TOOLS.filter((t) => t.name !== "definition_draft" && notMcp(t) && notDashboards(t)),
  },
  "analyst with a definition to change": {
    sections: (db) => analystSections(common(db)),
    tools: ANALYST_TOOLS.filter((t) => notMcp(t) && notDashboards(t)),
  },
  "analyst with connected services": {
    sections: (db) => analystSections(common(db)),
    tools: ANALYST_TOOLS.filter((t) => t.name !== "definition_draft" && notDashboards(t)),
  },
  // The dashboard tools go only in a conversation about a dashboard.
  "analyst building a dashboard": {
    sections: (db) => analystSections(common(db)),
    tools: ANALYST_TOOLS.filter((t) => t.name !== "definition_draft" && notMcp(t)),
  },
  investigator: {
    sections: (db) => investigatorSections({ ...common(db), insight, maxQueries: 25 }),
    tools: INVESTIGATOR_TOOLS,
  },
  modeler: {
    sections: (db) =>
      modelerSections({
        ...common(db),
        mode: "tables",
        existing: "",
        glossary: "",
        guides: "",
        maxQueries: 25,
        activeAccounts: dialectFor(db).advice.countDistinctWhere("account_id", "status = 'active'"),
        engines: db === "clickhouse",
      }),
    tools: MODELER_SOURCE_TOOLS,
  },
  // Leading a batch: no format, data rules or dialect, since it writes no definition.
  "modeler leading": {
    sections: (db) =>
      modelerSections({
        ...common(db),
        mode: "lead",
        existing: "",
        glossary: "",
        guides: "",
        maxQueries: 25,
        activeAccounts: dialectFor(db).advice.countDistinctWhere("account_id", "status = 'active'"),
        engines: db === "clickhouse",
      }),
    tools: MODELER_LEAD_TOOLS,
  },
  drafter: {
    sections: (db) =>
      modelerSections({
        ...common(db),
        mode: "group",
        existing: "",
        glossary: "",
        guides: "",
        maxQueries: 9,
        activeAccounts: dialectFor(db).advice.countDistinctWhere("account_id", "status = 'active'"),
        engines: db === "clickhouse",
      }),
    tools: DRAFTER_TOOLS,
  },
};

/**
 * Characters each sends, at most: today's sizes, rounded up a little. PRINT_SIZES=1 prints them. The tools grew by
 * about 1k with the knowledge folder (ls, read and grep for catalog_describe and skill_read), cached at the
 * first point, while the catalog left the source layer (100k characters on a 99-table source, now about 8k). A Modeler
 * leading a batch sends 1.2k (it hands out, its drafters write the definitions). The analyst's definition_draft (1.3k)
 * goes only in a conversation with a definition the asker may change attached, so its other calls send what they did.
 * clarify takes several questions (0.25k). Memory keeps a correction or preference without being asked, saying why
 * and what it's about (0.13k rules, 0.3k remember's fields). mcp_find and mcp_call (1.9k, mcp_find's server_id
 * among them) go only where connected services are on and the workspace has one. Retiring the old dashboards and Apps v1 took dashboard_find
 * and dashboard_save out of the analyst's tools, with the answer's found dashboards and clarify's dashboard options
 * (about 6.4k off every call), and its prompt's dashboards section and each dialect's filter notes (about 0.8k).
 * The new dashboards' tools (dashboard_plan, dashboard_save, dashboard_open: 4.2k, a change naming its base, the plan drawn with its ids) go only in a conversation about
 * one, with their skill in the conversation's layer. The plan names its chart kinds, how pages are reached and laid out
 * (0.3k). Building a page at a time (dashboard_start, dashboard_page: 2.2k) lands each page as
 * it passes, and makes the dashboard the moment Build it is pressed.
 */
// read names /results/<alias> (an earlier query's rows read back from the ledger, not rerun): about 70 more on
// every agent that reads.
// An answer's title and headline figures (cards above its text, in the page and in Slack), and charts for every trend
// or breakdown rather than one: about 0.53k of the analyst's prompt and 0.66k of its answer tool, on every call.
const ANALYST_AGENT = { postgres: 7_750, clickhouse: 8_150, mysql: 8_100 };
const BUDGET: Record<string, { agent: Record<Db, number>; tools: number }> = {
  analyst: { agent: ANALYST_AGENT, tools: 14_300 },
  "analyst with a definition to change": { agent: ANALYST_AGENT, tools: 15_550 },
  "analyst with connected services": { agent: ANALYST_AGENT, tools: 16_100 },
  // A list's row actions and a plan's changes took the tools past 20,600; the rest of the kit (meters, next
  // actions, zones, team focus, a head's chips and verdict, kept inputs, a plan's reference) to 21,490.
  // dashboard_save's set and edits (a change by path, an exact edit of a part): 22,285. The
  // build skill sent beside them shrank by about 5k the same day (its taste and the parts' API read when needed).
  // The plan's chart kinds took heatmap, sankey, timeline and boxplot: 22,325.
  // +900: app_check, the render check the analyst reads before it answers; the kit's
  // dashboard_page goes in the purge.
  "analyst building a dashboard": { agent: ANALYST_AGENT, tools: 23_300 },
  // +200, +300 on ClickHouse and MySQL: it carries the investigate-a-change skill's body, one method written once for it
  // and the analyst.
  investigator: { agent: { postgres: 4_100, clickhouse: 4_500, mysql: 4_500 }, tools: 10_800 },
  modeler: { agent: { postgres: 6_100, clickhouse: 6_600, mysql: 6_400 }, tools: 9_000 },
  "modeler leading": { agent: { postgres: 1_300, clickhouse: 1_300, mysql: 1_300 }, tools: 5_100 },
  drafter: { agent: { postgres: 6_300, clickhouse: 6_800, mysql: 6_600 }, tools: 8_700 },
};

const toolChars = async (tools: AgentTool[]) =>
  JSON.stringify(
    await Promise.all(
      tools.map(async (t) => ({
        name: t.name,
        description: t.description,
        inputSchema: await zodSchema(t.schema).jsonSchema,
      })),
    ),
  ).length;

describe("what every call sends before its conversation", () => {
  for (const [name, agent] of Object.entries(AGENTS)) {
    it(`stays within the ${name}'s budget on every database`, async () => {
      const sizes = Object.fromEntries(DATABASES.map((db) => [db, compose(agent.sections(db)).layers.agent.length]));
      const tools = await toolChars(agent.tools);
      if (process.env.PRINT_SIZES) console.log(`SIZE ${name} ${JSON.stringify(sizes)} tools ${tools}`);
      for (const db of DATABASES)
        expect(sizes[db], `${name} on ${db}`).toBeLessThanOrEqual(BUDGET[name]?.agent[db] ?? 0);
      expect(tools, `${name}'s tools`).toBeLessThanOrEqual(BUDGET[name]?.tools ?? 0);
    });
  }
});

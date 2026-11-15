// A finished answer for tests that need one without a model: its query runs, and an outcome citing them.
import { uuidv7 } from "@opendash/db";
import type { TestDatabase } from "@opendash/db/testing";

/** A succeeded SQL query run of a run, its one cell 412621.44 (mrr). */
export async function queryRunOf(t: TestDatabase, orgId: string, connectionId: string, runId: string, alias: string) {
  const id = uuidv7();
  await t.owner`
    insert into app.query_run (id, org_id, connection_id, requester_type, requester_id, alias, title, mode, path,
      engine, compiled_sql, sql_hash, status, preview, result_schema)
    values (${id}, ${orgId}, ${connectionId}, 'run', ${runId}, ${alias}, ${`MRR (${alias})`}, 'execute', 'raw_sql',
      'agent_sql', 'select 412621.44 as mrr', 'h', 'succeeded', ${t.owner.json([[412621.44]])},
      ${t.owner.json([{ name: "mrr", type: "number" }])})`;
  return id;
}

/** A finished answer citing one query in its text and another in its chart. */
export function answerCiting(textRunId: string, chartRunId: string) {
  const cite = (queryRunId: string, alias: string) => ({ alias, queryRunId, row: 0, column: "mrr" });
  return {
    kind: "answer",
    status: "answered",
    verified: true,
    markdown: "MRR was ⟦q1:0:mrr⟧.",
    rendered: "MRR was $412.6k.",
    interpretation: ["September 2026"],
    caveats: [],
    citations: [{ ref: "q1:0:mrr", ...cite(textRunId, "q1"), value: 412621.44 }],
    values: [],
    problems: [],
    path: "unmodelled",
    checked: { numbers: 1, claims: 0, crossChecks: 0 },
    context: [{ kind: "guide", id: uuidv7(), title: "Internal pricing guide", version: 1, how: "pinned" }],
    segments: {
      markdown: [
        { text: "MRR was " },
        { ref: "q1:0:mrr", display: "$412.6k", kind: "number", citations: [cite(textRunId, "q1")] },
        { text: "." },
      ],
      caveats: [],
      interpretation: [[{ text: "September 2026" }]],
    },
    charts: [
      {
        type: "bar",
        title: "MRR",
        horizontal: false,
        axis: { compact: true },
        categories: ["2026-09"],
        series: [{ name: "MRR", points: [{ value: 412621.44, display: "$412.6k", cell: cite(chartRunId, "q2") }] }],
      },
    ],
  };
}

// Describe it, measured: each case's words through the composer agent with a real model, graded on
// the routine it proposes, by name.
//
//   pnpm --filter @opendash/worker routines --model claude-haiku-5-5 [--only line-below,vague-team] [--concurrency 3]
//
// It calls the real model, so it runs on demand, not in CI, in a fresh database of its own (never a workspace of
// anyone's). The report goes to packages/evals/reports.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { createModelResolver, DEFAULT_MODEL, runAttempt } from "@opendash/agent";
import {
  type ComposerOutcome,
  checkDefinitions,
  composerChoices,
  composerResult,
  demoPack,
  getRun,
  installDefinitions,
  listDefinitions,
  parseLine,
  startComposer,
  verifyDefinitions,
} from "@opendash/core";
import { learnedSource } from "@opendash/core/testing";
import { type TenantTx, uuidv7 } from "@opendash/db";
import { withTenantOn } from "@opendash/db/testing";
import { gradeRoutine, NOW, ROUTINE_CASES, ROUTINE_FIXTURE, type RoutineCase, type RoutineView } from "@opendash/evals";
import type { PgBoss } from "pg-boss";
import { loadRootEnv } from "../../../scripts/load-env.mjs";

const root = path.resolve(import.meta.dirname, "../../..");
loadRootEnv(root);

const { values } = parseArgs({
  options: {
    model: { type: "string" },
    only: { type: "string" },
    concurrency: { type: "string", default: "3" },
  },
});
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("Set ANTHROPIC_API_KEY in .env.local: the cases ask the real model.");
  process.exit(2);
}
const modelId = values.model ?? DEFAULT_MODEL;
const only = values.only ? new Set(values.only.split(",").map((x) => x.trim())) : null;
const cases = ROUTINE_CASES.filter((c) => !only || only.has(c.id));

console.log("Setting up the demo company in a fresh Postgres database…");
const s = await learnedSource();
const ctx = { orgId: s.orgId, userId: s.userId };
await s.tenant((tx) =>
  installDefinitions(tx, ctx, s.connectionId, demoPack("postgres"), { status: "proposed", source: "pack" }),
);
await checkDefinitions(s.deps, { orgId: s.orgId, connectionId: s.connectionId }, { now: new Date(NOW) });
const defs = await s.tenant((tx) => listDefinitions(tx, s.orgId, { connectionId: s.connectionId }));
await s.tenant((tx) =>
  verifyDefinitions(
    tx,
    ctx,
    defs.map((d) => d.id),
  ),
);
// An owner (who may name anyone) and a member (only themselves).
const member = uuidv7();
for (const [id, name, role] of [
  [s.userId, "Maya Patel", "owner"],
  [member, "Theo Brown", "member"],
] as const) {
  await s.t.owner`insert into auth.user (id, name, email, email_verified)
    values (${id}, ${name}, ${`${name.split(" ")[0]?.toLowerCase()}@acme.example`}, true) on conflict do nothing`;
  await s.t.owner`insert into auth.member (id, organization_id, user_id, role, created_at)
    values (${uuidv7()}, ${s.orgId}, ${id}, ${role}, now())`;
}
const deps = {
  withTenant: s.deps.withTenant,
  withUser: <T>(orgId: string, userId: string, fn: (tx: TenantTx) => Promise<T>) =>
    withTenantOn(s.t.app, { orgId, userId }, fn),
  secrets: s.secrets,
  edition: "community" as const,
  model: createModelResolver({ withTenant: s.deps.withTenant, secrets: s.secrets }),
  now: () => new Date(NOW),
};
/** No job reaches a worker: the runner runs each attempt itself. */
const boss = { send: async () => "eval" } as unknown as PgBoss;

interface Row {
  id: string;
  text: string;
  pass: boolean;
  reason: string;
  got: RoutineView | null;
  understood: string;
  seconds: number;
  usage: Record<string, number>;
}

/** The proposal by name, as a person reads it. */
async function viewOf(o: ComposerOutcome, userId: string): Promise<{ view: RoutineView; line: number | null }> {
  const choices = await s.tenant((tx) => composerChoices(tx, { orgId: s.orgId, userId, canManage: true }));
  const d = o.draft;
  const metric = choices.metrics.find((m) => m.id === d.metricIds[0]);
  return {
    view: {
      trigger: d.trigger,
      repeats: d.repeats,
      days: d.days,
      on: d.on,
      at: d.at,
      action: d.action,
      question: d.question,
      metrics: d.metricIds.map((id) => choices.metrics.find((m) => m.id === id)?.title ?? id),
      condition: d.condition,
      direction: d.direction,
      line: d.line,
      tell: d.tell,
      investigate: d.investigate,
      people: o.people,
      channels: o.channels,
      asks: o.open,
    },
    line: metric && d.line ? parseLine(d.line, metric.format) : null,
  };
}

async function run(c: RoutineCase): Promise<Row> {
  const userId = c.as === "owner" ? s.userId : member;
  const started = Date.now();
  const { runId } = await s.tenant((tx) =>
    startComposer(
      tx,
      { boss, deploymentKeys: { anthropic: true } as never },
      {
        orgId: s.orgId,
        userId,
        text: c.text,
        people: ROUTINE_FIXTURE.people,
        channels: ROUTINE_FIXTURE.channels,
        canManage: c.as === "owner",
      },
    ),
  );
  await s.t.owner`update app.run set model = ${modelId} where id = ${runId}`;
  let error: string | null = null;
  try {
    await runAttempt(deps, { orgId: s.orgId, runId }, { workerId: "routines" });
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const viewer = { orgId: s.orgId, userId };
  const read = await s.tenant((tx) => composerResult(tx, viewer, runId));
  const r = await getRun(deps, viewer, runId);
  const seen = read?.status === "done" ? await viewOf(read.outcome, userId) : null;
  const graded = error
    ? { pass: false, reason: error }
    : !seen
      ? { pass: false, reason: read?.status === "failed" ? read.message : "no proposal" }
      : gradeRoutine(c, seen.view, seen.line);
  return {
    id: c.id,
    text: c.text,
    ...graded,
    got: seen?.view ?? null,
    understood: read?.status === "done" ? read.outcome.understood : "",
    seconds: Math.round((Date.now() - started) / 100) / 10,
    usage: (r?.usage ?? {}) as Record<string, number>,
  };
}

const rows: Row[] = [];
const queue = [...cases];
await Promise.all(
  Array.from({ length: Math.max(1, Number(values.concurrency)) }, async () => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      const row = await run(c);
      rows.push(row);
      const mark = row.pass ? "\x1b[32m✓\x1b[39m" : "\x1b[31m✗\x1b[39m";
      console.log(`${mark} ${row.id.padEnd(20)} ${row.seconds.toFixed(1).padStart(5)} s  ${row.reason}`);
      if (!row.pass) console.log(`    ${row.understood}`);
    }
  }),
);
rows.sort((a, b) => cases.findIndex((c) => c.id === a.id) - cases.findIndex((c) => c.id === b.id));
const passed = rows.filter((r) => r.pass).length;
const calls = rows.reduce((n, r) => n + (r.usage.modelCalls ?? 0), 0);
const cost = rows.reduce((n, r) => n + (r.usage.costUsd ?? 0), 0);
console.log(`\n${passed}/${rows.length} routines right on ${modelId} · ${calls} model calls · $${cost.toFixed(4)}`);
const dir = path.join(root, "packages/evals/reports");
mkdirSync(dir, { recursive: true });
const file = path.join(dir, `routines-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(
  file,
  `${JSON.stringify({ set: "routines", model: modelId, passed, total: rows.length, calls, cost, rows }, null, 2)}\n`,
);
console.log(`Report: ${path.relative(root, file)}`);
await s.close();
process.exit(passed === rows.length ? 0 : 1);

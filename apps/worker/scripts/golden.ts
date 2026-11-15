/**
 * pnpm evals [--set golden] [--only id,id] [--subset pr|glossary|search|traps] [--dialect postgres|clickhouse|mysql]
 *            [--model id] [--without metrics,glossary,guides,vectors] [--wording holdout|n] [--verified]
 *            [--trace] [--concurrency 3]
 *
 * DashBench (72 questions; --set golden, its first 21) asked of the demo company through the real analyst, each graded
 * against an answer computed from the data, refusals and clarifications included. Hermetic: a fresh database, the demo
 * seeded and learned the way the product does it, all dropped at the end. It spends (ANTHROPIC_API_KEY in .env.local):
 * Haiku by default, --model to ask another. Today is pinned to NOW (2026-10-10), so "last month" is always September.
 *
 * What the analyst is given: the demo pack's verified definitions, its glossary, its guides and, with OPENAI_API_KEY,
 * vectors. --without leaves any of them out, to measure what each is worth (--without metrics is the SQL-only
 * baseline). --wording holdout asks each question's held-out wording (written by an outside author, never where the
 * analyst can find it); --wording n its n-th other wording. --verified measures verified queries as retrieval: it asks
 * the dev wordings, saves a verified query from each right answer on the metric path, then asks the held-out wordings
 * and reports how many were given their own question's query, followed it, and were right. --subset traps asks the
 * three a database sets (ClickHouse's FINAL, integer division, MySQL's missing FILTER): run it with --dialect on each.
 *
 * Bar: zero untraced numbers (every answer passes its gate) and at least 75% of questions right.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { createModelResolver, openAiEmbedder, runAttempt } from "@opendash/agent";
import {
  approveContext,
  demoPack,
  embedOrganization,
  getRun,
  installDefinitions,
  runEvents,
  saveGuide,
  saveTerm,
  saveVerifiedQuery,
  submitQuestion,
} from "@opendash/core";
import { learnedSource } from "@opendash/core/testing";
import type { TenantTx } from "@opendash/db";
import { withTenantOn } from "@opendash/db/testing";
import {
  type BenchQuestion,
  DASHBENCH,
  DEMO_GUIDES,
  demoGlossary,
  GOLDEN,
  type GradedOutcome,
  grade,
  NOW,
} from "@opendash/evals";
import { HOLDOUT } from "@opendash/evals/holdout";
import { loadRootEnv } from "../../../scripts/load-env.mjs";
import { startTelemetry } from "../src/telemetry";
import { printEvent, printOutcome } from "./events";

const root = path.resolve(import.meta.dirname, "../../..");
loadRootEnv(root);
// Traces of the eval's runs too, when an OTLP endpoint is set.
const telemetry = startTelemetry("opendash-golden");
const EVAL_MODEL = "claude-haiku-5-5";

const { values } = parseArgs({
  options: {
    only: { type: "string" },
    trace: { type: "boolean", default: false },
    concurrency: { type: "string", default: "3" },
    model: { type: "string" },
    dialect: { type: "string", default: "postgres" },
    set: { type: "string", default: "dashbench" },
    subset: { type: "string" },
    without: { type: "string", default: "" },
    wording: { type: "string" },
    verified: { type: "boolean", default: false },
  },
});
const set = values.set === "golden" ? "golden" : "dashbench";
/** What the analyst is given, less what --without leaves out. */
const WITHOUT = ["metrics", "glossary", "guides", "vectors"] as const;
const without = new Set(
  values.without
    .split(",")
    .map((w) => w.trim())
    .filter(Boolean),
);
for (const w of without) {
  if (!(WITHOUT as readonly string[]).includes(w)) {
    console.error(`--without takes ${WITHOUT.join(", ")}: not "${w}".`);
    process.exit(2);
  }
}
const given = {
  metrics: !without.has("metrics"),
  glossary: !without.has("glossary"),
  guides: !without.has("guides"),
  vectors: !without.has("vectors"),
};
const holdout = values.wording === "holdout";
const phrasing = values.wording && !holdout ? Number(values.wording) : 0;
if (values.wording && !holdout && !(Number.isInteger(phrasing) && phrasing > 0)) {
  console.error('--wording takes "holdout" or a number (the n-th other wording).');
  process.exit(2);
}
const dialect = values.dialect === "clickhouse" || values.dialect === "mysql" ? values.dialect : "postgres";
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("Set ANTHROPIC_API_KEY in .env.local: the golden set asks the real model.");
  process.exit(2);
}
const only = values.only ? new Set(values.only.split(",").map((s) => s.trim())) : null;
const questions = (set === "dashbench" ? DASHBENCH : (GOLDEN as BenchQuestion[]))
  .filter((g) => !only || only.has(g.id))
  .filter((g) => !values.subset || g.subset === values.subset)
  .map((g) => (phrasing && g.phrasings?.[phrasing - 1] ? { ...g, question: g.phrasings[phrasing - 1] as string } : g))
  .map((g) => (holdout && !values.verified ? { ...g, question: HOLDOUT[g.id] ?? g.question } : g));
/** Haiku unless asked: an eval run spends, and the product's default (Sonnet) costs several times as much. */
const modelId = values.model ?? EVAL_MODEL;

console.log(
  `Setting up the demo company in a fresh ${{ postgres: "Postgres", clickhouse: "ClickHouse", mysql: "MySQL" }[dialect]} database…`,
);
const s = await learnedSource({ dialect });
if (given.metrics) {
  const prefix = s.prefix;
  const pack = demoPack(dialect, {
    public: `${prefix}public`,
    billing: `${prefix}billing`,
    support: `${prefix}support`,
  });
  const added = await s.tenant((tx) =>
    installDefinitions(tx, { orgId: s.orgId, userId: s.userId }, s.connectionId, pack, {
      status: "verified",
      source: "pack",
    }),
  );
  console.log(`Installed and verified the demo pack: ${added} definitions.`);
}
if (given.glossary) {
  const prefix = s.prefix;
  const ctx = { orgId: s.orgId, userId: s.userId };
  const terms = await s.tenant(async (tx) => {
    const saved = [];
    for (const body of demoGlossary(`${prefix}public`))
      saved.push(await saveTerm(tx, ctx, { body, connectionId: s.connectionId }));
    return approveContext(tx, ctx, saved);
  });
  console.log(`Saved and approved the demo glossary: ${terms.length} terms.`);
}
if (given.guides) {
  const ctx = { orgId: s.orgId, userId: s.userId };
  const saved = await s.tenant(async (tx) => {
    const ids = [];
    for (const g of DEMO_GUIDES) ids.push(await saveGuide(tx, ctx, { ...g, connectionId: s.connectionId }));
    return approveContext(tx, ctx, ids);
  });
  console.log(`Saved and approved the demo guides (unpinned): ${saved.length}.`);
}
// Vectors: what's approved, embedded with the deployment's OpenAI key, as the worker's batch would.
const openAiKey = process.env.OPENAI_API_KEY?.trim();
const embedder = given.vectors && openAiKey ? openAiEmbedder(openAiKey) : null;
if (embedder) {
  const embedded = await embedOrganization(s.deps, s.orgId, embedder);
  console.log(`Embedded the workspace's knowledge and tables: ${embedded.embedded}.`);
} else {
  console.log(
    given.vectors ? "No OPENAI_API_KEY: searching by words only." : "Searching by words only (--without vectors).",
  );
}
const deps = {
  withTenant: s.deps.withTenant,
  withUser: <T>(orgId: string, userId: string, fn: (tx: TenantTx) => Promise<T>) =>
    withTenantOn(s.t.app, { orgId, userId }, fn),
  secrets: s.secrets,
  edition: "community" as const,
  model: createModelResolver({ withTenant: s.deps.withTenant, secrets: s.secrets }),
  now: () => new Date(NOW),
  ...(embedder ? { embedder: async () => embedder } : {}),
};

interface Row {
  id: string;
  question: string;
  trap: string;
  pass: boolean;
  untraced: boolean;
  reason: string;
  /** The path the answer's numbers took: metric, unmodelled, or none (no answer). */
  path: string;
  outcome: GradedOutcome | null;
  seconds: number;
  usage: Record<string, number>;
  trace: string[];
}

// With --verified the owner asks (a verified query is saved from a conversation its saver can see).
const asker = values.verified ? s.userId : null;
const viewer = { orgId: s.orgId, userId: asker };

async function ask(g: BenchQuestion): Promise<Row> {
  const expectation = await g.expect(s.source.query);
  const started = Date.now();
  const submitted = await submitQuestion(
    { withTenant: deps.withTenant, boss: null },
    {
      orgId: s.orgId,
      userId: asker,
      connectionId: s.connectionId,
      text: g.question,
      channel: "eval",
      model: modelId,
    },
  );
  let error: string | null = null;
  try {
    await runAttempt(deps, { orgId: s.orgId, runId: submitted.runId }, { workerId: "golden" });
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const run = await getRun(deps, viewer, submitted.runId);
  const outcome = (run?.outcome ?? null) as GradedOutcome | null;
  const graded = error ? { pass: false, untraced: false, reason: error } : grade(expectation, outcome);
  const trace: string[] = [];
  for (const e of await runEvents(deps, viewer, submitted.runId)) printEvent(e, (l) => trace.push(l));
  printOutcome(outcome as Record<string, unknown> | null, (l) => trace.push(l));
  return {
    id: g.id,
    question: g.question,
    trap: g.trap,
    ...graded,
    path:
      (outcome as { kind?: string; path?: string } | null)?.kind === "answer"
        ? ((outcome as { path?: string }).path ?? "unmodelled")
        : "none",
    outcome,
    seconds: Math.round((Date.now() - started) / 100) / 10,
    usage: run?.usage ?? {},
    trace,
  };
}

async function askAll(list: BenchQuestion[], extra: (row: Row) => string = () => ""): Promise<Row[]> {
  const done: Row[] = [];
  const queue = [...list];
  const workers = Array.from({ length: Math.max(1, Number(values.concurrency)) }, async () => {
    for (let g = queue.shift(); g; g = queue.shift()) {
      const row = await ask(g);
      done.push(row);
      const mark = row.pass ? "\x1b[32m✓\x1b[39m" : "\x1b[31m✗\x1b[39m";
      console.log(
        `${mark} ${row.id.padEnd(22)} ${row.path.padEnd(10)} ${row.seconds.toFixed(1).padStart(5)} s  ${row.reason}${extra(row)}`,
      );
      if (values.trace || !row.pass) {
        console.log(row.trace.map((l) => `    ${l}`).join("\n"));
      }
    }
  });
  await Promise.all(workers);
  return done;
}

/** The metric queries an answer's numbers cite. */
const citedMetricQueries = (outcome: GradedOutcome | null) => {
  const o = outcome as { segments?: { markdown?: { citations?: { queryRunId: string }[] }[] } } | null;
  return [...new Set((o?.segments?.markdown ?? []).flatMap((seg) => (seg.citations ?? []).map((c) => c.queryRunId)))];
};

let rows: Row[] = [];
let dev: Row[] = [];
const savedFor = new Map<string, string>();
try {
  if (values.verified) {
    console.log("Asking the dev wordings, to save what they got right…");
    dev = await askAll(questions);
    for (const r of dev) {
      if (!r.pass || r.path !== "metric") continue;
      for (const queryRunId of citedMetricQueries(r.outcome)) {
        try {
          const v = await s.tenant((tx) =>
            saveVerifiedQuery(tx, { orgId: s.orgId, userId: s.userId }, { queryRunId, question: r.question }),
          );
          savedFor.set(r.id, v.id);
          break;
        } catch {
          // Not a metric query that ran, or the question is already saved: try the next one it cites.
        }
      }
    }
    console.log(
      `Saved ${savedFor.size} verified queries from ${dev.length} dev answers. Asking the held-out wordings…`,
    );
    const held = questions.map((g) => ({ ...g, question: HOLDOUT[g.id] ?? g.question }));
    rows = await askAll(held, (row) => {
      const v = verifiedUse(row);
      return v.given ? (v.followed ? "  · followed its verified query" : "  · given its verified query") : "";
    });
  } else {
    rows = await askAll(questions);
  }
} finally {
  await s.close();
}

/** Whether a held-out answer was given (and followed) the verified query saved from its own dev wording. */
function verifiedUse(row: Row) {
  const mine = savedFor.get(row.id);
  const ctx = (
    (row.outcome as { context?: { id: string; kind: string; followed?: boolean }[] } | null)?.context ?? []
  ).filter((c) => c.kind === "verified_query");
  const own = ctx.find((c) => c.id === mine);
  return {
    saved: Boolean(mine),
    given: Boolean(own),
    followed: Boolean(own?.followed),
    others: ctx.length - (own ? 1 : 0),
  };
}

rows.sort((a, b) => questions.findIndex((q) => q.id === a.id) - questions.findIndex((q) => q.id === b.id));
const passed = rows.filter((r) => r.pass).length;
const untraced = rows.filter((r) => r.untraced).length;
const sum = (k: string) => rows.reduce((t, r) => t + (r.usage[k] ?? 0), 0);
/** How much of what was sent came from the prompt cache, and what the run cost. */
const cached = `${Math.round((sum("cachedInputTokens") / Math.max(1, sum("inputTokens"))) * 100)}% cached`;
const share = passed / Math.max(1, rows.length);
const onMetric = rows.filter((r) => r.path === "metric").length;
const bar = untraced === 0 && share >= 0.75;
const metricRight = rows.filter((r) => r.path === "metric" && r.pass).length;
console.log(
  `\n${passed}/${rows.length} right (${Math.round(share * 100)}%) · ${onMetric} on the metric path · ${untraced} with untraced numbers · ${sum("modelCalls")} model calls · ${sum("inputTokens")} input tokens (${sum("cachedInputTokens")} cached, ${cached}) · ${sum("outputTokens")} output tokens · $${sum("costUsd").toFixed(4)}`,
);
console.log(
  `Metric path: ${metricRight}/${onMetric} right (${Math.round((metricRight / Math.max(1, onMetric)) * 100)}%)`,
);
console.log(
  bar
    ? "Bar met: zero untraced numbers, at least 75% right."
    : "Bar not met (zero untraced numbers and at least 75% right).",
);
const retrieval = values.verified
  ? (() => {
      const withSaved = rows.filter((r) => savedFor.has(r.id));
      const uses = withSaved.map((r) => ({ r, v: verifiedUse(r) }));
      const given = uses.filter((u) => u.v.given);
      const followed = uses.filter((u) => u.v.followed);
      const r = {
        dev: { passed: dev.filter((d) => d.pass).length, total: dev.length, saved: savedFor.size },
        held: withSaved.length,
        given: given.length,
        followed: followed.length,
        right: uses.filter((u) => u.r.pass).length,
        rightWhenFollowed: followed.filter((u) => u.r.pass).length,
        others: rows.filter((x) => verifiedUse(x).others > 0).length,
      };
      console.log(
        `Verified queries: ${r.dev.saved} saved from ${r.dev.passed}/${r.dev.total} right dev answers · of their ${r.held} held-out wordings, ${r.given} were given their own verified query, ${r.followed} followed it, ${r.right} were right (${r.rightWhenFollowed} of those that followed) · ${r.others} answers were also given another question's`,
      );
      return r;
    })()
  : null;

const dir = path.join(root, "packages/evals/reports");
mkdirSync(dir, { recursive: true });
const file = path.join(dir, `${set}-${dialect}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(
  file,
  `${JSON.stringify({ set, model: modelId, dialect, now: NOW, phrasing, holdout: holdout || values.verified, verified: retrieval, definitions: given.metrics, glossary: given.glossary, guides: given.guides, vectors: Boolean(embedder), passed, total: rows.length, onMetric, metricRight, untraced, bar, rows }, null, 2)}\n`,
);
console.log(`Report: ${path.relative(root, file)}`);
await telemetry?.shutdown();
process.exit(bar ? 0 : 1);

/**
 * pnpm ask "How did MRR change last month?" [--source <name>] [--org <name>] [--thread <id>] [--model <id>]
 *
 * Asks the Analyst a question against a connected source in your local database and prints the trace as it runs: the
 * same runAttempt the worker uses, run in this process (no job is queued, so a running worker won't pick it up).
 * Needs ANTHROPIC_API_KEY in .env.local; every question is a few model calls.
 */
import path from "node:path";
import { parseArgs } from "node:util";
import { createModelResolver, DEFAULT_MODEL, runAttempt } from "@opendash/agent";
import { createSecretStore, getRun, kekFromEnv, runEvents, submitQuestion } from "@opendash/core";
import { closeDatabases, sql, withSystem, withTenant } from "@opendash/db";
import { loadRootEnv } from "../../../scripts/load-env.mjs";
import { printEvent, printOutcome } from "./events";

loadRootEnv(path.resolve(import.meta.dirname, "../../.."));

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    source: { type: "string" },
    org: { type: "string" },
    thread: { type: "string" },
    model: { type: "string" },
  },
});
const question = positionals.join(" ").trim();
if (!question) {
  console.error('Usage: pnpm ask "your question" [--source <name>] [--org <name>] [--thread <id>]');
  process.exit(2);
}

const sources = await withSystem((tx) =>
  tx.execute<{ org_id: string; org: string; id: string; name: string; sample: boolean }>(sql`
    select c.org_id, o.name as org, c.id, c.name, coalesce((c.config->>'sample')::boolean, false) as sample
    from app.connection c join app.org o on o.id = c.org_id
    where c.deleted_at is null
      and exists (select 1 from app.catalog_object k where k.org_id = c.org_id and k.connection_id = c.id)
    order by o.name, c.name`),
).catch((error: { code?: string }) => {
  if (error.code === "42P01") {
    console.error("The database isn't migrated: run pnpm db:migrate.");
    process.exit(1);
  }
  throw error;
});
const matches = sources.filter(
  (s) =>
    (!values.source || s.name.toLowerCase() === values.source.toLowerCase()) &&
    (!values.org || s.org.toLowerCase() === values.org.toLowerCase()),
);
if (matches.length !== 1) {
  console.error(
    matches.length
      ? "Several sources match; pick one with --source (and --org):"
      : "No learned source matches. Connect one in the app, or seed the demo (pnpm demo:seed) and connect it.",
  );
  for (const s of matches.length ? matches : sources) console.error(`  --org "${s.org}" --source "${s.name}"`);
  process.exit(1);
}
const source = matches[0] as (typeof matches)[number];

const withTenantDeps = <T>(orgId: string, fn: Parameters<typeof withTenant<T>>[1]) => withTenant({ orgId }, fn);
const secrets = createSecretStore({ kek: kekFromEnv() });
const deps = {
  withTenant: withTenantDeps,
  secrets,
  edition: process.env.OPENDASH_EDITION === "cloud" ? ("cloud" as const) : ("community" as const),
  model: createModelResolver({ withTenant: withTenantDeps, secrets }),
};

const submitted = await submitQuestion(
  { withTenant: deps.withTenant, boss: null },
  {
    orgId: source.org_id,
    userId: null,
    connectionId: source.id,
    ...(values.thread ? { threadId: values.thread } : {}),
    text: question,
    channel: "api",
    model: values.model ?? DEFAULT_MODEL,
  },
);
console.log(`\x1b[2m${source.org} · ${source.name} · thread ${submitted.threadId}\x1b[22m`);
console.log(`\x1b[1m${question}\x1b[22m`);

const viewer = { orgId: source.org_id, userId: null };
const started = Date.now();
let seen = 0;
const drain = async () => {
  for (const e of await runEvents(deps, viewer, submitted.runId, seen)) {
    printEvent(e);
    seen = e.seq;
  }
};
const poller = setInterval(() => void drain().catch(() => {}), 300);
try {
  await runAttempt(deps, { orgId: source.org_id, runId: submitted.runId }, { workerId: "pnpm-ask" });
} finally {
  clearInterval(poller);
  await drain();
}
const run = await getRun(deps, viewer, submitted.runId);
printOutcome(run?.outcome as Record<string, unknown> | null);
const u = run?.usage ?? {};
console.log(
  `\x1b[2m${((Date.now() - started) / 1000).toFixed(1)} s · ${u.modelCalls ?? 0} model calls · ${u.inputTokens ?? 0} in (${u.cachedInputTokens ?? 0} cached) / ${u.outputTokens ?? 0} out tokens · follow up with --thread ${submitted.threadId}\x1b[22m`,
);
await closeDatabases();
process.exit(run?.status === "succeeded" ? 0 : 1);

#!/usr/bin/env node
/**
 * pnpm e2e: the end-to-end browser tests (apps/web/e2e), against an instance started for them.
 *
 * 1. A database of its own, `opendash_e2e`, made afresh on the development Postgres (`pnpm db:up`), and the sample
 *    company beside it (packages/db/scripts/e2e-database.ts, apps/worker/scripts/e2e-setup.ts). The development
 *    database is never touched.
 * 2. The web app (`next dev`, port 3391) and a worker, on that database, sending email only to the local inbox
 *    (`pnpm mail:up`: Mailpit, which relays nothing) and with no Slack, analytics or traces, whatever .env.local says.
 * 3. Playwright, in Chromium. Anything after `--` goes to it: `pnpm e2e -- --headed`, `pnpm e2e -- --ui`.
 *    `pnpm e2e --serve` stops after step 2 and leaves the instance running, to write a test against.
 *
 * The model keys in your settings are left out unless E2E_MODEL=1, so a run costs nothing: the test that asks a
 * question is skipped without one. Stop your own `pnpm dev` first: Next.js runs one dev server per folder.
 */
import { spawn, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { loadRootEnv } from "./load-env.mjs";

const root = path.resolve(import.meta.dirname, "..");
loadRootEnv(root);

const PORT = process.env.E2E_PORT ?? "3391";
const ORIGIN = `http://localhost:${PORT}`;
const MAILPIT = process.env.E2E_MAILPIT_URL ?? "http://127.0.0.1:8027";
const SMTP = process.env.E2E_SMTP_URL ?? "smtp://127.0.0.1:1027?requireTLS=false";
const DATABASE = "opendash_e2e";
const DEMO_PASSWORD = process.env.E2E_DEMO_READER_PASSWORD ?? "opendash-e2e-demo";

function fail(message) {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}
/** A development URL, pointed at the tests' own database: the same server, role and password. */
function own(name) {
  const value = process.env[name]?.trim();
  if (!value) fail(`Set ${name} (see .env.example): the tests run on the same Postgres as development.`);
  const url = new URL(value);
  url.pathname = `/${DATABASE}`;
  return url.toString();
}
// A space, not nothing: an empty value would be filled in again from .env.local (load-env.mjs), and every reader
// trims. This is how a developer's real keys stay out of a test run.
const OFF = " ";
const model = process.env.E2E_MODEL === "1";

const env = {
  ...process.env,
  NODE_ENV: "development",
  PORT,
  DATABASE_URL: own("DATABASE_URL"),
  DATABASE_SYSTEM_URL: own("DATABASE_SYSTEM_URL"),
  DATABASE_AUTH_URL: own("DATABASE_AUTH_URL"),
  DATABASE_OWNER_URL: own("DATABASE_OWNER_URL"),
  DATABASE_DIRECT_URL: own("DATABASE_DIRECT_URL"),
  DATABASE_QUEUE_URL: own("DATABASE_QUEUE_URL"),
  DATABASE_ADMIN_URL: OFF,
  DATABASE_POOLED: "false",
  E2E_ADMIN_URL: process.env.E2E_ADMIN_URL ?? process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_OWNER_URL,
  E2E_DEMO_READER_PASSWORD: DEMO_PASSWORD,
  BETTER_AUTH_URL: ORIGIN,
  BETTER_AUTH_TRUSTED_ORIGINS: OFF,
  OPENDASH_OLD_HOSTS: OFF,
  OPENDASH_FRAMES_URL: OFF,
  OPENDASH_INVITE_ONLY: "0",
  OPENDASH_EDITION: "community",
  OPENDASH_LICENSE_KEY: OFF,
  OPENDASH_SUPPORT_EMAIL: "hello@opendash.internal",
  OPENDASH_DOCS_URL: OFF,
  OPENDASH_STATUS_URL: OFF,
  // Email: the local inbox only. Resend wins when its key is set, so it's taken out.
  RESEND_API_KEY: OFF,
  SMTP_URL: SMTP,
  EMAIL_FROM: "OpenDash <e2e@opendash.internal>",
  SLACK_CLIENT_ID: OFF,
  SLACK_CLIENT_SECRET: OFF,
  SLACK_SIGNING_SECRET: OFF,
  SLACK_APP_TOKEN: OFF,
  SLACK_PUBLIC_URL: OFF,
  POSTHOG_KEY: OFF,
  OTEL_EXPORTER_OTLP_ENDPOINT: OFF,
  ...(model
    ? {}
    : { AI_GATEWAY_API_KEY: OFF, ANTHROPIC_API_KEY: OFF, OPENAI_API_KEY: OFF, GOOGLE_GENERATIVE_AI_API_KEY: OFF }),
  // What the tests themselves read.
  E2E_ORIGIN: ORIGIN,
  E2E_MAILPIT_URL: MAILPIT,
  E2E_MODEL: model ? "1" : "",
  E2E_DEMO: JSON.stringify({
    host: new URL(own("DATABASE_OWNER_URL")).hostname,
    port: new URL(own("DATABASE_OWNER_URL")).port || "5432",
    database: "opendash_e2e_demo",
    user: "opendash_e2e_reader",
    password: DEMO_PASSWORD,
  }),
};

const up = async (url) =>
  fetch(url, { signal: AbortSignal.timeout(3_000) }).then(
    (r) => r.ok,
    () => false,
  );
if (!(await up(`${MAILPIT}/api/v1/info`))) fail("The local inbox isn't running: pnpm mail:up.");
if (await up(`${ORIGIN}/api/health`)) fail(`Something already answers on ${ORIGIN}: stop it first.`);

console.log("▸ A database of its own");
for (const [pkg, script] of [
  ["@opendash/db", "scripts/e2e-database.ts"],
  ["@opendash/worker", "scripts/e2e-setup.ts"],
]) {
  const step = spawnSync("pnpm", ["--silent", "--filter", pkg, "exec", "tsx", script], {
    cwd: root,
    env,
    stdio: "inherit",
  });
  if (step.status !== 0) fail("The database couldn't be readied (is Postgres up? pnpm db:up).");
}

/** The servers, each in a process group of its own so stopping one stops what it started. */
const servers = [];
function start(name, args, cwd) {
  const child = spawn("pnpm", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const lines = [];
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      lines.push(String(chunk));
      if (lines.length > 400) lines.shift();
      if (process.env.E2E_LOGS === "1") process.stdout.write(`[${name}] ${chunk}`);
    });
  }
  servers.push({ name, child, lines });
  return child;
}
let stopped = false;
function stop() {
  if (stopped) return;
  stopped = true;
  for (const { child } of servers) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
}
process.on("exit", stop);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stop();
    process.exit(130);
  });
}
function logs() {
  for (const { name, lines } of servers)
    console.error(`\n--- ${name} (its last lines) ---\n${lines.join("").slice(-6000)}`);
}

// The dev server's cache from an earlier run: started on it again, Turbopack can answer every page load with "HMR
// hash mismatch" and reload the page without end (seen 2026-11-15, cured by removing it). A cold start costs a few
// seconds, and the pages the tests open first are warmed below.
rmSync(path.join(root, "apps/web/.next/dev"), { recursive: true, force: true });

console.log("▸ The web app and a worker");
const web = start("web", ["exec", "next", "dev", "--port", PORT], path.join(root, "apps/web"));
const worker = start("worker", ["exec", "tsx", "src/index.ts"], path.join(root, "apps/worker"));
for (const [name, child] of [
  ["web", web],
  ["worker", worker],
]) {
  child.on("exit", (code) => {
    if (stopped) return;
    logs();
    fail(`The ${name} stopped (${code ?? "killed"}) before the tests were done.`);
  });
}
const deadline = Date.now() + 180_000;
for (;;) {
  // The dispatcher too (strict): the worker is up, so a connection check is picked up.
  if (await up(`${ORIGIN}/api/health?strict=1`)) break;
  if (Date.now() > deadline) {
    logs();
    fail("The web app and the worker didn't come up in three minutes.");
  }
  await new Promise((r) => setTimeout(r, 1_000));
}

// The first page a dev server draws is compiled as it's asked for, which on a cold start takes longer than a test
// should wait for a click: the pages the tests open first are asked for once here.
for (const page of ["/sign-up", "/check-email", "/welcome/password", "/onboarding/organization"]) {
  await fetch(`${ORIGIN}${page}`, { redirect: "manual", signal: AbortSignal.timeout(120_000) }).catch(() => {});
}

const passed = process.argv.slice(2).filter((a) => a !== "--");
// --serve: the instance alone, left running, to write a test against: run them from apps/web with
// `E2E_MODEL=… pnpm exec playwright test` (the settings below are printed for it), and stop it with Ctrl-C.
if (passed.includes("--serve")) {
  console.log(`\n✓ Serving on ${ORIGIN}. In another terminal, from apps/web:\n`);
  console.log(
    `  E2E_ORIGIN=${ORIGIN} E2E_MAILPIT_URL=${MAILPIT} E2E_DEMO='${env.E2E_DEMO}' pnpm exec playwright test\n`,
  );
  await new Promise(() => {});
}
console.log("▸ The tests");
const tests = spawnSync("pnpm", ["exec", "playwright", "test", ...passed], {
  cwd: path.join(root, "apps/web"),
  env,
  stdio: "inherit",
});
if (tests.status !== 0) logs();
stop();
process.exit(tests.status ?? 1);

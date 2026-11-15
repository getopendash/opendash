#!/usr/bin/env node
// Checks the local toolchain before `pnpm dx`. Prints what's missing and how to fix it.
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { loadRootEnv } from "./load-env.mjs";

const root = path.resolve(import.meta.dirname, "..");
const results = [];
const check = (name, ok, fix) => results.push({ name, ok, fix });
const run = (cmd) => {
  try {
    return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "";
  }
};

const wantNode = readFileSync(path.join(root, ".nvmrc"), "utf8").trim();
check(
  `Node ${wantNode.split(".")[0]}`,
  process.versions.node.split(".")[0] === wantNode.split(".")[0],
  `nvm use (wants ${wantNode}, have ${process.versions.node})`,
);
check("pnpm", run("pnpm -v") !== "", "corepack enable");
check("Docker running", run("docker info --format '{{.ServerVersion}}'") !== "", "start Docker (or OrbStack)");
check(".env present", existsSync(path.join(root, ".env")), "cp .env.example .env and fill in the keys you have");

// The settings the web app needs, after .env.local and .env are merged the way the app merges them.
const env = { ...process.env };
loadRootEnv(root, env);
for (const key of [
  "BETTER_AUTH_SECRET",
  "OPENDASH_KEK",
  "DATABASE_URL",
  "DATABASE_AUTH_URL",
  "DATABASE_SYSTEM_URL",
  "DATABASE_QUEUE_URL",
]) {
  check(`${key} set`, Boolean(env[key]?.trim()), `set ${key} in .env (see .env.example)`);
}
check(
  "Email: RESEND_API_KEY and EMAIL_FROM together",
  Boolean(env.RESEND_API_KEY?.trim()) === Boolean(env.EMAIL_FROM?.trim()),
  "set both in .env.local to send real email, or neither to print links in the server log",
);

const portFree = (port) =>
  new Promise((resolve) => {
    const s = net.createServer().once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true))).listen(port, "127.0.0.1");
  });
const composeUp = run("docker compose -f infra/docker-compose.yml ps --status running -q postgres") !== "";
check(
  "Port 5444 for Postgres",
  composeUp || (await portFree(5444)),
  "free port 5444 or change infra/docker-compose.yml",
);
check("Port 3000 for web", await portFree(3000), "stop whatever is on :3000");

for (const r of results) console.info(`${r.ok ? "✓" : "✗"} ${r.name}${r.ok ? "" : `  →  ${r.fix}`}`);
process.exit(results.every((r) => r.ok || r.name === ".env present" || r.name.startsWith("Port 3000")) ? 0 : 1);

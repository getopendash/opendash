#!/usr/bin/env node
// OpenDash's Slack app manifest (infra/slack/manifest.json), filled in and ready to paste at https://api.slack.com/apps
// → Create New App → From a manifest (JSON), or over an existing app's App Manifest. Every workspace adds the app
// with Add to Slack. Slack only calls https: the address is where Slack reaches OpenDash (SLACK_PUBLIC_URL;
// locally, a tunnel to the web app).
//
//   pnpm slack:manifest https://<address>            Events and button presses at <address>/api/slack/events, Add to
//                                                    Slack back at <address>/api/slack/oauth.
//   pnpm slack:manifest https://<address> --socket   Socket Mode (SLACK_APP_TOKEN): the worker holds the connection,
//                                                    so Slack sends no events to an address (a self-host with no
//                                                    public one); Add to Slack still comes back to <address>.
//   pnpm slack:tunnel [port]                         Local: a Cloudflare quick tunnel to the web app (localhost:3000),
//                                                    and the manifest for its address. Keep it running; a new tunnel
//                                                    has a new address, so paste the manifest again then.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const template = readFileSync(path.join(root, "infra/slack/manifest.json"), "utf8");

/** The manifest for OpenDash at `origin` (https): its events over HTTPS there, or over the worker's socket. */
export function slackManifest(origin, { socket = false } = {}) {
  const url = new URL(origin);
  if (url.protocol !== "https:")
    throw new Error("Slack only calls https addresses (locally: a tunnel, pnpm slack:tunnel).");
  const m = JSON.parse(template.replaceAll("<WEB_URL>", url.origin));
  if (socket) {
    delete m.settings.event_subscriptions.request_url;
    delete m.settings.interactivity.request_url;
    m.settings.socket_mode_enabled = true;
  }
  return m;
}

const steps = (socket, address) =>
  [
    "",
    "Then, in the app's settings at api.slack.com/apps:",
    "  1. Basic Information → App Credentials: put the Client ID, Client Secret and Signing Secret in .env.local as",
    "     SLACK_CLIENT_ID, SLACK_CLIENT_SECRET and SLACK_SIGNING_SECRET.",
    `  2. In .env.local, SLACK_PUBLIC_URL=${address ?? "<this address>"} (when it isn't the web app's own).`,
    socket
      ? "  3. Basic Information → App-Level Tokens: generate one with connections:write, as SLACK_APP_TOKEN."
      : "  3. Event Subscriptions → Retry, so Slack checks the address once OpenDash answers it.",
    "  4. Restart the web app and the worker; then Settings → Slack → Add to Slack, and approve it in Slack.",
  ].join("\n");

const print = (manifest) => process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);

const args = process.argv.slice(2);
const socket = args.includes("--socket");
const [arg, portArg] = args.filter((a) => a !== "--socket");
if (arg === "--tunnel") {
  const port = /^\d{2,5}$/.test(portArg ?? "") ? portArg : "3000";
  const tunnel = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", `http://localhost:${port}`], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  tunnel.on("error", () => {
    console.error("cloudflared isn't installed: brew install cloudflared");
    process.exit(1);
  });
  let found = false;
  tunnel.stderr.on("data", (chunk) => {
    const address = found ? null : String(chunk).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];
    if (!address) return;
    found = true;
    console.error(`\nThe tunnel: ${address} → localhost:${port}. The manifest for it:\n`);
    print(slackManifest(address));
    console.error([steps(false, address), "", "Leave this running (Ctrl-C closes the tunnel)."].join("\n"));
  });
  tunnel.on("exit", (code) => process.exit(code ?? 0));
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => tunnel.kill(signal));
} else if (arg) {
  try {
    print(slackManifest(arg, { socket }));
    console.error(steps(socket, new URL(arg).origin));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
} else {
  console.error(
    "Usage: pnpm slack:manifest https://<host> [--socket]   (pnpm slack:tunnel for a local tunnel without https)",
  );
  process.exit(1);
}

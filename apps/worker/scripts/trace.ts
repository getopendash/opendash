// A run's trace, for whoever runs the deployment: how each attempt ended, what its latest attempt was
// sent (each stored layer by hash and size, the tools offered, what the conversation layer held), and each model call
// with its tokens, cache share, price and tool calls. As the system role: never a member's view. It never calls a
// model, and a memory's text never shows: none is stored.
//
//   pnpm --filter @opendash/worker trace <run id> [--full] [--events]
//     --full    each stored layer's text
//     --events  the run's events as they happened, while they're kept (3 days on Cloud)
import path from "node:path";
import { parseArgs } from "node:util";
import { promptLayerText, type RunTrace, type TracedCall, traceRun } from "@opendash/core";
import { closeDatabases, isUuid, sql, withSystem } from "@opendash/db";
import { loadRootEnv } from "../../../scripts/load-env.mjs";
import { printEvent } from "./events";

loadRootEnv(path.resolve(import.meta.dirname, "../../.."));
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { full: { type: "boolean", default: false }, events: { type: "boolean", default: false } },
});
const runId = positionals[0] ?? "";
if (!isUuid(runId)) {
  console.error("Usage: pnpm --filter @opendash/worker trace <run id> [--full] [--events]");
  process.exit(2);
}

const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
const n = (x: number) => x.toLocaleString("en-US");
const time = (at?: string | Date) => (at ? new Date(at).toISOString().slice(11, 19) : "?");
const secs = (ms: number | null) => (ms === null ? "" : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
const usd = (x: number | null) => (x === null ? "unpriced" : `$${x.toFixed(4)}`);

function call(c: TracedCall): string {
  const what = c.alias ? `${c.alias} "${c.title}" · ${n(c.rows ?? 0)} rows` : "";
  const verdict =
    c.accepted === undefined ? "" : c.accepted ? "accepted" : `sent back: ${(c.problems ?? []).join(" ")}`;
  return [
    `→ ${c.tool}`,
    what,
    c.status === "succeeded" ? "" : c.status,
    verdict,
    // An error's first line: a schema miss quotes the model's whole input.
    (c.error ?? "").split("\n")[0]?.slice(0, 160) ?? "",
    c.repaired ? `(${c.repaired})` : "",
    dim(secs(c.ms)),
  ]
    .filter(Boolean)
    .join(" · ");
}

function print(t: RunTrace) {
  const r = t.run;
  console.log(bold(`Run ${r.id} · ${r.profile} · ${r.model} · ${r.status}${r.outcome ? ` (${r.outcome})` : ""}`));
  console.log(dim(`Thread ${r.threadId} · ${r.trigger} · queued ${new Date(r.queuedAt).toISOString()}`));
  if (r.error) console.log(`Error: ${r.error}`);

  console.log(bold("\nAttempts"));
  for (const a of t.attempts) console.log(`  ${a.attempt}  ${time(a.started)} → ${time(a.ended)}  ${a.reason}`);

  console.log(bold(`\nPrompt${t.prompt ? ` (attempt ${t.prompt.attempt})` : ""}`));
  if (!t.prompt) {
    console.log(dim("  Not recorded: the run ended before its first model call, or it's from before 2026-10-15."));
  } else {
    for (const layer of ["agent", "source", "question"] as const) {
      const hash = t.prompt[layer];
      if (hash)
        console.log(
          `  ${layer.padEnd(9)} ${n(t.prompt.sizes[layer] ?? 0).padStart(9)} chars  ${dim(hash.slice(0, 12))}`,
        );
    }
    console.log(`  tools     ${t.prompt.tools.join(", ")}`);
    const kinds = t.prompt.attached.map((a) => a.kind);
    console.log(
      `  conversation  ${kinds.length ? `${kinds.length} attached (${kinds.join(", ")})` : "nothing attached"} · memory: ${t.prompt.memories} ${t.prompt.memories === 1 ? "fact" : "facts"} given (never stored)`,
    );
  }

  console.log(bold("\nModel calls"));
  steps(t, "");
}

/** A run's model calls and their tool calls; a child a call ran, nested under it. Returns its cost. */
function steps(t: RunTrace, pad: string): number {
  console.log(dim(`${pad}   #   input   cached  written   output  cost`));
  let input = 0;
  let cached = 0;
  let total = 0;
  let children = 0;
  const added = [...t.followUps];
  for (const [i, s] of t.steps.entries()) {
    // A follow-up read before this call.
    while (added[0] && added[0].seq < s.seq) {
      console.log(`${pad}     ↳ read a follow-up: "${(added.shift()?.text ?? "").slice(0, 120)}"`);
    }
    const u = s.usage;
    if (i > 0) {
      input += u.inputTokens ?? 0;
      cached += u.cachedInputTokens ?? 0;
    }
    total += s.costUsd ?? 0;
    console.log(
      `${pad}  ${String(i + 1).padStart(2)} ${n(u.inputTokens ?? 0).padStart(7)} ${n(u.cachedInputTokens ?? 0).padStart(8)} ${n(u.cacheWriteTokens ?? 0).padStart(8)} ${n(u.outputTokens ?? 0).padStart(8)}  ${usd(s.costUsd)}${s.stopReason === "length" ? "  cut off at its output limit" : ""}`,
    );
    for (const c of s.calls) {
      console.log(`${pad}        ${call(c)}`);
      if (c.reusedChild) console.log(`${pad}          ↳ the same drafter as above (${c.reusedChild}), counted once`);
      if (c.child) {
        const k = c.child.run;
        console.log(
          `${pad}          ↳ ${k.profile} ${k.id} · ${k.status}${k.outcome ? ` (${k.outcome})` : ""} · attempts ${k.attempt}`,
        );
        children += steps(c.child, `${pad}          `);
      }
    }
  }
  const share = input ? `${Math.round((cached / input) * 100)}% of input from the cache on calls 2+` : "";
  const theirs = children ? ` · with its children ${usd(total + children)}` : "";
  console.log(dim(`${pad}  ${t.steps.length} calls · ${usd(total)}${theirs}${share ? ` · ${share}` : ""}`));
  return total + children;
}

try {
  const trace = await withSystem((tx) => traceRun(tx, runId));
  if (!trace) {
    console.error(`No run ${runId}.`);
    process.exitCode = 1;
  } else {
    print(trace);
    if (values.full && trace.prompt) {
      for (const layer of ["agent", "source", "question"] as const) {
        const hash = trace.prompt[layer];
        if (!hash) continue;
        const text = await withSystem((tx) => promptLayerText(tx, trace.run.orgId, hash));
        console.log(bold(`\n── ${layer} layer ──`));
        console.log(text ?? dim("(not found)"));
      }
    }
    if (values.events) {
      const events = await withSystem((tx) =>
        tx.execute<{ seq: number; attempt: number; type: string; data: Record<string, unknown> }>(sql`
          select seq, attempt, type, data from app.run_event
          where org_id = ${trace.run.orgId} and run_id = ${runId} and type <> 'delta' order by seq`),
      );
      console.log(bold("\nEvents"));
      if (!events.length) console.log(dim("  None kept: a run's events are dropped after 3 days."));
      for (const e of events) printEvent(e);
    }
  }
} finally {
  await closeDatabases();
}

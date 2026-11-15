/**
 * Prints a run's events as a readable trace in the terminal: what the model thought and said, each tool call (SQL
 * and parameters in full), each result, the gate's problems, and the answer. Shared by `pnpm ask`, the golden set and
 * the trace command (while a run's events are kept).
 */
import { clarifyQuestions } from "@opendash/core/clarify";

const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
const indent = (s: string, by = "    ") => s.replace(/^/gm, by);

type Event = { seq: number; attempt: number; type: string; data: Record<string, unknown> };

function toolCall(call: { tool?: string; input?: unknown }): string {
  const input = (call.input ?? {}) as Record<string, unknown>;
  switch (call.tool) {
    case "sql_query":
    case "sql_check": {
      const params = (input.params as { name: string; value: unknown }[] | undefined) ?? [];
      return [
        `→ ${call.tool}${input.title ? `: ${input.title}` : ""}`,
        indent(String(input.sql ?? "").trim()),
        ...(params.length
          ? [indent(dim(params.map((p, i) => `$${i + 1} ${p.name} = ${JSON.stringify(p.value)}`).join("  ")))]
          : []),
      ].join("\n");
    }
    case "answer":
      return `→ answer (${input.status})\n${indent(String(input.markdown ?? ""))}`;
    case "clarify":
      return `→ clarify: ${clarifyQuestions(input)
        .map((q) => `${q.question} ${dim(JSON.stringify(q.options))}${q.multiple ? dim(" (several)") : ""}`)
        .join(" ")}`;
    default:
      return `→ ${call.tool} ${dim(JSON.stringify(input))}`;
  }
}

export function printEvent(e: Event, write: (line: string) => void = (l) => process.stdout.write(`${l}\n`)) {
  const d = e.data;
  switch (e.type) {
    case "attempt_started":
      write(dim(`— attempt ${d.attempt}`));
      break;
    case "assistant_message": {
      if (d.reasoning) write(dim(indent(`Thinking: ${String(d.reasoning).trim()}`, "  ")));
      if (d.text) write(`  ${String(d.text).trim()}`);
      // Tool calls print when they start (tool_started), with their full input.
      break;
    }
    case "tool_started":
      write(indent(toolCall({ tool: d.tool as string, input: d.input }), "  "));
      break;
    case "tool_result": {
      const warnings = (d.warnings as string[] | undefined) ?? [];
      let line = `← ${d.tool}`;
      if (d.status !== "succeeded") line += `: ${d.status}${d.error ? ` · ${d.error}` : ""}`;
      else if (d.failed) line += `: failed (${d.kind}) · ${d.message}`;
      else if (d.alias) line += `: ${d.alias}, ${d.rows} rows`;
      else if (d.tool === "answer") {
        line += d.accepted
          ? `: accepted${d.verified ? "" : " (unverified)"}`
          : `: sent back\n${indent(((d.problems as string[]) ?? []).map((p) => `- ${p}`).join("\n"))}`;
      }
      write(indent(line, "  "));
      for (const w of warnings) write(indent(dim(`! ${w}`), "    "));
      break;
    }
    case "note":
      write(dim(`  (${d.text})`));
      break;
    case "run_end":
      write(dim(`— ${d.status} · ${d.outcome}`));
      break;
    default:
      write(dim(`  ${e.type} ${JSON.stringify(d)}`));
  }
}

export function printOutcome(
  outcome: Record<string, unknown> | null,
  write: (line: string) => void = (l) => process.stdout.write(`${l}\n`),
) {
  if (!outcome) return;
  write("");
  if (outcome.kind === "answer") {
    write(bold(String(outcome.rendered ?? "")));
    const chips = (outcome.interpretation as string[]) ?? [];
    if (chips.length) write(dim(chips.join(" · ")));
    for (const c of (outcome.caveats as string[]) ?? []) write(dim(`Caveat: ${c}`));
    if (!outcome.verified) write(`Unverified: ${((outcome.problems as string[]) ?? []).join(" ")}`);
  } else if (outcome.kind === "clarify") {
    for (const q of clarifyQuestions(outcome)) {
      write(bold(q.question));
      for (const o of q.options) write(`  ${q.multiple ? "[ ]" : "-"} ${o}`);
    }
  } else {
    write(bold(`No answer: ${outcome.reason}`));
  }
}

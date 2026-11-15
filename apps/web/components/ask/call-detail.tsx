"use client";

import type { CallDetail } from "@opendash/core";
import { useQuery } from "@tanstack/react-query";
import { apiQueries } from "@/lib/api";

/**
 * One call, opened, so every call's work shows in the chat: a query's SQL and first rows,
 * a save's edits as diffs, a service's arguments and what came back, a file read. For the person who asked only; the
 * server says nothing to anyone else.
 */
export function CallBody({ runId, callId }: { runId: string; callId: string }) {
  const q = useQuery(apiQueries.runs.step.queryOptions({ input: { runId, callId } }));
  if (q.isPending) return <p className="text-small text-muted-tertiary">Opening…</p>;
  if (q.isError) return <p className="text-small text-muted">Couldn't open it. Try again in a moment.</p>;
  if (!q.data) return <p className="text-small text-muted">Only the person who asked sees what this call did.</p>;
  return <Detail d={q.data} />;
}

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
/** Any value as text: one that has none in JSON (undefined, a function) says so rather than breaking. */
const json = (v: unknown): string => JSON.stringify(v, null, 2) ?? String(v);

/** Text the call worked with, monospaced, scrolling inside its box past a few lines. */
function Code({ text, label }: { text: string; label?: string }) {
  return (
    <div className="flex flex-col gap-1">
      {label ? <span className="text-micro text-muted-tertiary">{label}</span> : null}
      <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface-secondary px-3 py-2 font-mono text-small leading-relaxed text-foreground">
        {text}
      </pre>
    </div>
  );
}

/** A text's lines, each with a key of its own (its place in this snapshot, which never changes). */
const linesOf = (text: string, mark: string) => text.split("\n").map((line, at) => ({ line, key: `${mark}${at}` }));

/** An edit: what was there, struck, and what's there now. */
function Diff({ label, before, after }: { label: string; before?: string; after: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-micro text-muted-tertiary">{label}</span>
      <div className="max-h-60 overflow-auto rounded-lg bg-surface-secondary py-1.5 font-mono text-small leading-relaxed">
        {before !== undefined
          ? linesOf(before, "-").map((x) => (
              <div
                key={x.key}
                className="whitespace-pre-wrap break-words bg-danger-soft px-3 text-danger-soft-foreground"
              >
                − {x.line}
              </div>
            ))
          : null}
        {linesOf(after, "+").map((x) => (
          <div
            key={x.key}
            className="whitespace-pre-wrap break-words bg-success-soft px-3 text-success-soft-foreground"
          >
            + {x.line}
          </div>
        ))}
      </div>
    </div>
  );
}

function Rows({ columns, rows, total }: { columns: string[]; rows: unknown[][]; total: number | null }) {
  if (!columns.length) return null;
  const shown = rows.slice(0, 8);
  const cell = (v: unknown) => (v === null || v === undefined ? "—" : typeof v === "object" ? json(v) : String(v));
  return (
    <div className="flex flex-col gap-1">
      <div className="max-w-full overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-small">
          <thead>
            <tr className="bg-surface-secondary text-muted">
              {columns.map((c) => (
                <th key={c} className="whitespace-nowrap px-2.5 py-1 text-left font-normal">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: rows of one result
              <tr key={i} className="border-t border-border">
                {columns.map((c, j) => (
                  <td key={c} className="max-w-48 truncate whitespace-nowrap px-2.5 py-1 tabular-nums">
                    {cell(r[j])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <span className="text-micro text-muted-tertiary">
        {total !== null && total > shown.length
          ? `The first ${shown.length} of ${total.toLocaleString("en-US")} rows`
          : `${shown.length} ${shown.length === 1 ? "row" : "rows"}`}
      </span>
    </div>
  );
}

/** Too long to keep whole: the server sent its start (`{ cut, start }`). */
const cutStart = (v: unknown): string | null => {
  const o = obj(v);
  return o.cut === true && typeof o.start === "string" ? o.start : null;
};

function Detail({ d }: { d: CallDetail }) {
  const input = obj(d.input);
  const output = obj(d.output);
  const parts: React.ReactNode[] = [];
  const inputCut = cutStart(d.input);
  const outputCut = cutStart(d.output);
  if (inputCut !== null || outputCut !== null) {
    // Shown as it's kept, saying it's cut: never read as an input with nothing in it.
    parts.push(
      <Code
        key="in"
        label={inputCut !== null ? "Sent (its start: it was long)" : "Sent"}
        text={inputCut ?? json(d.input)}
      />,
    );
    if (d.output !== null && d.output !== undefined) {
      parts.push(
        <Code
          key="out"
          label={outputCut !== null ? "Came back (its start: it was long)" : "Came back"}
          text={outputCut ?? json(d.output)}
        />,
      );
    }
  } else if (d.query) {
    parts.push(<Code key="sql" label="The query that ran" text={d.query.sql} />);
    parts.push(<Rows key="rows" columns={d.query.columns} rows={d.query.rows} total={d.query.total} />);
  } else if (d.tool === "dashboard_save" || d.tool === "dashboard_page") {
    // Each entry as an object, its texts as text: a refused call keeps whatever it was sent.
    const edits = Array.isArray(input.edits) ? (input.edits as unknown[]).map(obj) : [];
    for (const [i, e] of edits.entries()) {
      parts.push(
        <Diff key={`e${i}`} label={str(e.file) ?? "A file"} before={str(e.old) ?? ""} after={str(e.new) ?? ""} />,
      );
    }
    const set = Array.isArray(input.set) ? (input.set as unknown[]).map(obj) : [];
    for (const [i, c] of set.entries()) {
      parts.push(
        <Diff
          key={`s${i}`}
          label={str(c.path) ?? "A change"}
          after={c.value === null ? "(removed)" : c.value === undefined ? "(no value)" : json(c.value)}
        />,
      );
    }
    const page = obj(input.page);
    if (Object.keys(page).length) {
      // A refused save keeps what it was sent, however malformed: only sections that are objects are read.
      const sections = Array.isArray(page.sections) ? (page.sections as unknown[]).map(obj) : [];
      parts.push(
        <Code
          key="page"
          label={`Page ${str(page.title) ?? str(page.id) ?? ""}`}
          text={sections
            .map((x) => `${str(x.id) ?? ""} · ${str(x.kind) ?? ""}${str(x.title) ? ` · ${str(x.title)}` : ""}`)
            .join("\n")}
        />,
      );
    }
    for (const [file, source] of Object.entries(obj(input.files))) {
      parts.push(
        typeof source === "string" ? (
          <Diff key={file} label={`${file} · written`} after={source} />
        ) : (
          <Code key={file} label={file} text="(removed)" />
        ),
      );
    }
    if (input.definition && !Object.keys(page).length) {
      parts.push(<Code key="def" label="The whole definition" text={json(input.definition)} />);
    }
    const problems = Array.isArray(output.problems) ? (output.problems as unknown[]) : [];
    if (problems.length) {
      parts.push(
        <Code
          key="problems"
          label="What the check found"
          text={problems.map((p) => (typeof p === "string" ? p : json(p))).join("\n")}
        />,
      );
    }
  } else if (d.tool === "mcp_call") {
    parts.push(
      <Code key="args" label={`${str(input.tool) ?? "The tool"}, called with`} text={json(input.arguments ?? {})} />,
    );
    const said = str(output.result) ?? str(output.error);
    if (said) parts.push(<Code key="said" label="What it sent back" text={said} />);
  } else if (d.tool === "read" || d.tool === "ls" || d.tool === "grep") {
    const said = str(output.content) ?? str(output.entries) ?? str(output.matches);
    parts.push(<Code key="path" label={d.tool} text={str(input.path) ?? str(input.pattern) ?? json(input)} />);
    if (said) parts.push(<Code key="said" label="What it read" text={said} />);
  }
  if (!parts.length) {
    parts.push(<Code key="in" label="Sent" text={json(d.input)} />);
    if (d.output !== null && d.output !== undefined)
      parts.push(<Code key="out" label="Came back" text={json(d.output)} />);
  }
  // Why it was refused, whatever the call: the call's error, or the error its result carries (an edit that didn't match).
  const why = d.error ?? (d.tool === "mcp_call" ? null : (str(output.error) ?? null));
  if (why) parts.push(<Code key="err" label="What went wrong" text={why} />);
  return <div className="flex flex-col gap-2">{parts}</div>;
}

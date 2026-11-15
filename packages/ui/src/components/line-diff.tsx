/**
 * One row of a line diff: a line both texts have, one the newer added or removed (`mark`: in a line changed in
 * place, the words that differ, [from, to) in its text), or unchanged lines folded.
 */
export type LineDiffRow =
  | { kind: "same" | "added" | "removed"; text: string; mark?: [number, number] }
  | { kind: "gap"; lines: number };

const SIGN = { same: " ", added: "+", removed: "−" } as const;

/** A line's text, the words it changed in bold. */
function Text({ text, mark, kind }: { text: string; mark?: [number, number]; kind: "same" | "added" | "removed" }) {
  if (!mark) return <>{text || " "}</>;
  return (
    <>
      {text.slice(0, mark[0])}
      <span
        className={`font-semibold ${kind === "added" ? "text-success-soft-foreground" : "text-danger-soft-foreground"}`}
      >
        {text.slice(mark[0], mark[1])}
      </span>
      {text.slice(mark[1])}
    </>
  );
}

/**
 * Two versions of a text, line by line (a definition's draft against its released YAML): what the newer
 * one added and removed, with the lines around each change, and the rest folded. Long lines wrap, so a change at the
 * end of a description shows in a narrow column.
 */
export function LineDiff({ lines, empty = "No changes." }: { lines: LineDiffRow[]; empty?: string }) {
  if (!lines.length) return <p className="text-small text-muted">{empty}</p>;
  return (
    <div className="rounded-xl border border-border bg-surface-secondary py-1.5 font-mono text-small leading-relaxed">
      {lines.map((l, i) =>
        l.kind === "gap" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows of one diff, in order
          <div key={i} className="px-3 py-0.5 text-muted-tertiary">
            ⋯ {l.lines} unchanged {l.lines === 1 ? "line" : "lines"}
          </div>
        ) : (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: rows of one diff, in order
            key={i}
            className={`flex gap-3 px-3 ${l.kind === "added" ? "bg-diff-added" : l.kind === "removed" ? "bg-diff-removed" : ""}`}
          >
            <span className="w-3 shrink-0 select-none text-muted-tertiary" aria-hidden>
              {SIGN[l.kind]}
            </span>
            <span className="min-w-0 flex-1 break-words whitespace-pre-wrap">
              {l.kind === "same" ? null : <span className="sr-only">{l.kind}: </span>}
              <Text text={l.text} kind={l.kind} {...(l.mark ? { mark: l.mark } : {})} />
            </span>
          </div>
        ),
      )}
    </div>
  );
}

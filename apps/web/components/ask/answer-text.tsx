"use client";

import type { AnswerSegment } from "@opendash/core";
import {
  type Block,
  type Inline,
  numericColumns,
  parseMarkdown,
  plainText,
  REF_CLOSE,
  REF_OPEN,
} from "@opendash/markdown";
import { TracedNumber } from "@opendash/ui";
import { Fragment, type ReactNode } from "react";

export type TracedRef = Extract<AnswerSegment, { ref: string }>;

type Ref = TracedRef;

const PLACEHOLDER = new RegExp(`${REF_OPEN}(\\d+)${REF_CLOSE}`, "g");

/** How a text part is drawn: its references (and, in a draft, its numbers) in place, its own line breaks kept. */
export type Leaf = (value: string, key: string) => ReactNode[];

/**
 * Markdown as an answer draws it, the CommonMark way (@opendash/markdown, as a PDF reads it): the checked answer and
 * its draft alike, so the answer lands where its draft was and only its numbers change. Every text goes through `leaf`.
 * Nothing in it is ever HTML, and no link in it is ever followed. A `draft` draws code through `leaf` too, a link
 * without its address and a numbered list from one: nothing in a draft shows a number before the gate checked it.
 */
export function AnswerBlocks({
  blocks,
  leaf,
  draft = false,
  tableAction,
  className = "text-lead",
}: {
  blocks: Block[];
  leaf: Leaf;
  draft?: boolean;
  /** Drawn at the end of a table's header row, from the references (placeholder indexes) in its cells. */
  tableAction?: (refs: number[]) => ReactNode;
  className?: string;
}) {
  const inline = (parts: Inline[], key: string): ReactNode[] =>
    parts.map((p, i) => {
      const k = `${key}-${i}`;
      switch (p.kind) {
        case "text":
          return <Fragment key={k}>{leaf(p.text, k)}</Fragment>;
        case "bold":
          return <strong key={k}>{inline(p.children, k)}</strong>;
        case "italic":
          return <em key={k}>{inline(p.children, k)}</em>;
        case "struck":
          return <s key={k}>{inline(p.children, k)}</s>;
        case "code":
          return (
            <code key={k} className="rounded-sm bg-surface-secondary px-1 font-mono text-body">
              {draft ? leaf(p.text, k) : p.text}
            </code>
          );
        case "break":
          return <br key={k} />;
        default: {
          // A link is never followed from here: an answer is the model's writing, steered by the data it read, and
          // a link could carry what it read to someone else's site. Its text, with the address beside it when the
          // text doesn't already say it, for the reader to see and copy (a draft's waits for the checked answer).
          const label = plainText(p.children);
          const shown = draft ? null : (p.href ?? null);
          return (
            <Fragment key={k}>
              {inline(p.children, k)}
              {shown && label.trim() !== shown && label.trim() !== shown.replace(/\/$/, "") ? (
                <span className="text-muted break-all"> ({shown})</span>
              ) : null}
            </Fragment>
          );
        }
      }
    });

  /** A table cell as text, for its column's alignment: a reference is its placeholder, as the check expects. */
  const cellText = (parts: Inline[]) => plainText(parts);

  const block = (b: Block, key: string): ReactNode => {
    switch (b.kind) {
      case "paragraph":
        return <p key={key}>{inline(b.content, key)}</p>;
      case "heading":
        return (
          <p key={key} className="font-medium">
            {inline(b.content, key)}
          </p>
        );
      case "list": {
        // An item that's one paragraph is its text; anything more (a nested list) is drawn as blocks.
        const items = b.items.map((item, i) => {
          const k = `${key}-${i}`;
          const [first, ...rest] = item;
          return (
            <li key={k}>
              {first?.kind === "paragraph" ? inline(first.content, k) : first ? block(first, `${k}-0`) : null}
              {rest.map((r, j) => block(r, `${k}-${j + 1}`))}
            </li>
          );
        });
        return b.start === null ? (
          <ul key={key} className="flex list-disc flex-col gap-1 ps-5">
            {items}
          </ul>
        ) : (
          <ol key={key} {...(draft ? {} : { start: b.start })} className="flex list-decimal flex-col gap-1 ps-5">
            {items}
          </ol>
        );
      }
      case "table": {
        const numeric = numericColumns({ align: b.align, head: b.head, rows: b.rows.map((r) => r.map(cellText)) });
        const align = (c: number) =>
          numeric[c] ? "text-right" : b.align[c] === "center" ? "text-center" : "text-left";
        // A trailing cell in the header, so the table keeps its rows' height when its action arrives.
        const refs = [...[b.head, ...b.rows].flat().map(cellText).join("").matchAll(PLACEHOLDER)].map((m) =>
          Number(m[1]),
        );
        const action = tableAction && refs.length ? tableAction(refs) : null;
        return (
          <div key={key} className="overflow-x-auto">
            <table className="border-collapse text-body tabular-nums">
              <thead>
                <tr className="border-b border-border-secondary text-muted">
                  {b.head.map((h, c) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: table cells are positional
                    <th key={c} className={`py-1.5 pe-6 font-medium last:pe-0 ${align(c)}`}>
                      {inline(h, `${key}-h${c}`)}
                    </th>
                  ))}
                  {action ? <th className="w-0 py-0.5 text-right align-middle">{action}</th> : null}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((row, r) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: table rows are positional
                  <tr key={r} className="border-b border-border last:border-b-0">
                    {b.head.map((_, c) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: table cells are positional
                      <td key={c} className={`py-1.5 pe-6 last:pe-0 ${align(c)}`}>
                        {inline(row[c] ?? [], `${key}-${r}-${c}`)}
                      </td>
                    ))}
                    {action ? <td /> : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      }
      case "code":
        return (
          <pre key={key} className="overflow-x-auto rounded-lg bg-surface-secondary px-3 py-2 font-mono text-body">
            {draft ? leaf(b.text, key) : b.text}
          </pre>
        );
      case "quote":
        return (
          <blockquote key={key} className="flex flex-col gap-2 border-s-2 border-border ps-3 text-muted">
            {b.children.map((c, i) => block(c, `${key}-${i}`))}
          </blockquote>
        );
      case "rule":
        return <hr key={key} className="border-border" />;
    }
  };

  return <div className={`flex flex-col gap-2.5 ${className}`}>{blocks.map((b, i) => block(b, `b${i}`))}</div>;
}

/**
 * An answer's text from its segments (the gate's pieces): the model's markdown (`AnswerBlocks`), with each reference
 * rendered as a traced number from its cells. Nothing in the text itself is ever shown as a number to trace: only
 * references are.
 */
export function AnswerText({
  segments,
  scope,
  selected,
  unverified,
  onTrace,
  tableAction,
  className = "text-lead",
}: {
  segments: AnswerSegment[];
  /** Names this text among the run's texts (answer, caveat-0…), so a traced number's key is unique. */
  scope: string;
  /** The key (scope:index) of the number being traced. */
  selected?: string | null;
  unverified?: boolean;
  onTrace?: (segment: Ref, key: string) => void;
  /** Drawn by a table's header, from the queries its cells cite (its CSV). */
  tableAction?: (queryRunIds: string[]) => ReactNode;
  className?: string;
}) {
  // References become private-use placeholders, so the markdown is parsed once and they come back in place.
  const refs: Ref[] = [];
  const source = segments
    .map((s) => {
      if ("text" in s) return s.text;
      refs.push(s);
      return `${REF_OPEN}${refs.length - 1}${REF_CLOSE}`;
    })
    .join("");

  /** A text part: its references as traced numbers, its own line breaks kept. */
  const leaf: Leaf = (value, key) => {
    const out: ReactNode[] = [];
    let at = 0;
    let i = 0;
    const plain = (t: string) =>
      t.split("\n").forEach((line, n) => {
        if (n > 0) out.push(<br key={`${key}-br${i++}`} />);
        if (line) out.push(line);
      });
    for (const m of value.matchAll(PLACEHOLDER)) {
      plain(value.slice(at, m.index));
      const index = Number(m[1]);
      const ref = refs[index];
      const k = `${key}-${i++}`;
      if (ref) {
        out.push(
          ref.kind === "unresolved" ? (
            <span key={k} className="text-muted-tertiary">
              [?]
            </span>
          ) : (
            <TracedNumber
              key={k}
              display={ref.display}
              selected={selected === `${scope}:${index}`}
              unverified={unverified}
              {...(onTrace ? { onPress: () => onTrace(ref, `${scope}:${index}`) } : {})}
            />
          ),
        );
      }
      at = m.index + m[0].length;
    }
    plain(value.slice(at));
    return out;
  };

  const cited = (indexes: number[]) => [
    ...new Set(indexes.flatMap((i) => (refs[i]?.citations ?? []).map((c) => c.queryRunId))),
  ];
  return (
    <AnswerBlocks
      blocks={parseMarkdown(source)}
      leaf={leaf}
      className={className}
      {...(tableAction ? { tableAction: (indexes: number[]) => tableAction(cited(indexes)) } : {})}
    />
  );
}

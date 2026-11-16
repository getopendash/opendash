/**
 * The answer's draft as it streams, made safe to show: the only path from a draft to the screen. The draft is drawn
 * with the checked answer's own renderer (AnswerText's blocks), so the checked answer lands where the draft was and only
 * its numbers change. Nothing in it shows a figure before the gate checked it:
 * - every reference (⟦q1:0:mrr⟧), and a reference still being written (an unclosed ⟦ and whatever follows), is a
 *   placeholder before the parse (`draftBlocks`), drawn as a grey pill;
 * - after the parse, every number in any text drawn (prose, a table cell, code, a link's words, whatever an entity
 *   decodes to) is a pill too (`draftPieces`), and a link's address and a numbered list's first number aren't drawn.
 * The markdown itself is never rewritten: what's still being written is tidied on the parsed blocks. Pure, so it's
 * tested on its own.
 */
import { type Block, type Inline, parseMarkdown, REF_CLOSE, REF_OPEN } from "@opendash/markdown";

export type DraftPiece = { kind: "text"; text: string } | { kind: "pill" } | { kind: "caret" };

/**
 * A number as it could be written: a sign, a currency, digits with separators, a percent or a scale. Any numeral
 * counts (\p{N}: fullwidth digits, ½, ², Ⅻ, as an entity can decode to), and every run of them is one, even in a word
 * ("3x", "Q3"): the gate checks every digit it isn't told is a date or a code, so the draft hides at least as much as
 * the gate would refuse.
 */
const NUMBER = /[-+−]?[$€£¥]?\p{N}(?:[\p{N}.,]*\p{N})?%?(?:[kKmMbB]n?(?!\p{L}))?/gu;

/** Where the draft is being written: a private-use character, put in the parsed blocks' last text, never the source. */
export const CARET = "";

const PLACEHOLDER = `${REF_OPEN}\\d*${REF_CLOSE}`;
const PIECE = new RegExp(`(${PLACEHOLDER}|${CARET})`, "u");
const IS_PLACEHOLDER = new RegExp(`^${PLACEHOLDER}$`, "u");

/** The draft's markdown, ready to parse: every reference, and one still being written, a placeholder. */
export function draftSource(draft: string): string {
  const open = draft.lastIndexOf("⟦");
  const pending = open >= 0 && draft.indexOf("⟧", open) < 0;
  let n = 0;
  const ref = () => `${REF_OPEN}${n++}${REF_CLOSE}`;
  const text = (pending ? draft.slice(0, open) : draft).replace(/\r/g, "").replace(/⟦[^⟦⟧]*⟧/g, ref);
  return pending ? text + ref() : text;
}

/** An inline list's plain text, as far as tidying needs it. */
const textOf = (parts: Inline[]): string =>
  parts
    .map((p) => (p.kind === "text" || p.kind === "code" ? p.text : p.kind === "break" ? "\n" : textOf(p.children)))
    .join("");

/** The inline list that ends a block, where the caret goes and marks still open show; none for a rule. */
function lastInlines(block: Block): Inline[] | { code: Extract<Block, { kind: "code" }> } | null {
  switch (block.kind) {
    case "paragraph":
    case "heading":
      return block.content;
    case "list": {
      const item = block.items.at(-1);
      if (!item) return null;
      // A list item just started ("- "): the caret goes in it.
      if (!item.length) item.push({ kind: "paragraph", content: [] });
      const last = item.at(-1);
      return last ? lastInlines(last) : null;
    }
    case "table":
      return block.rows.at(-1)?.at(-1) ?? block.head.at(-1) ?? null;
    case "quote": {
      const last = block.children.at(-1);
      return last ? lastInlines(last) : null;
    }
    case "code":
      return { code: block };
    case "rule":
      return null;
  }
}

/** Marks the parse left as text in what's being written (a bold or code still open): hidden until they close. */
const strayMarks = (parts: Inline[]) => {
  for (const p of parts) {
    if (p.kind === "text") p.text = p.text.replace(/\*\*|`+/g, "");
    else if (p.kind === "bold" || p.kind === "italic" || p.kind === "struck" || p.kind === "link")
      strayMarks(p.children);
  }
};

/**
 * The draft as blocks, for `AnswerBlocks`. While it's being written, its end is tidied on the parsed blocks, so the
 * markdown's structure is the parser's: a table being started (a last paragraph that begins with a pipe) waits until it
 * parses as a table, marks still open in the last block are hidden, and the caret ends its last text.
 */
export function draftBlocks(draft: string, writing = true): Block[] {
  const source = draftSource(draft);
  if (!writing) return parseMarkdown(source);
  // A lone dash ending a line of text is a list item being started, not a heading's underline: the caret is its text,
  // so the parse reads a list rather than flashing the line above as a heading.
  const starting = /\n {0,3}-[ \t]*$/.test(source);
  const blocks = parseMarkdown(starting ? source.replace(/-[ \t]*$/, `- ${CARET}`) : source);
  if (starting) return blocks;
  const last = blocks.at(-1);
  if (last?.kind === "paragraph" && textOf(last.content).trimStart().startsWith("|")) blocks.pop();
  const end = blocks.at(-1);
  const inlines = end ? lastInlines(end) : null;
  if (inlines && "code" in inlines) inlines.code.text += CARET;
  else if (inlines) {
    strayMarks(inlines);
    inlines.push({ kind: "text", text: CARET });
  } else blocks.push({ kind: "paragraph", content: [{ kind: "text", text: CARET }] });
  return blocks;
}

/** A text of the parsed draft as words, pills and the caret: every placeholder and every number a pill. */
export function draftPieces(text: string): DraftPiece[] {
  const out: DraftPiece[] = [];
  const push = (piece: DraftPiece) => {
    const last = out.at(-1);
    if (piece.kind === "text" && !piece.text) return;
    if (piece.kind === "text" && last?.kind === "text") last.text += piece.text;
    else out.push(piece);
  };
  for (const part of text.split(PIECE)) {
    if (part === CARET) push({ kind: "caret" });
    else if (IS_PLACEHOLDER.test(part)) push({ kind: "pill" });
    else {
      let at = 0;
      for (const m of part.matchAll(NUMBER)) {
        push({ kind: "text", text: part.slice(at, m.index) });
        push({ kind: "pill" });
        at = m.index + m[0].length;
      }
      push({ kind: "text", text: part.slice(at) });
    }
  }
  return out;
}

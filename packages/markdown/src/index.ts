/**
 * An answer's markdown, read the CommonMark way (GitHub's tables and strikethrough with it): the parser Chat SDK uses
 * for Slack (mdast), so the page, a PDF and Slack read an answer alike. It gives blocks (paragraphs, headings, lists,
 * tables, code, quotes) of inline parts (text, bold, italics, code, links), for each channel to draw its own way.
 *
 * Nothing in an answer is ever drawn as HTML: anything tag-shaped is its own text, an image is its alt text, and a
 * link has a target only when it's http(s) or mailto. References (the gate's numbers) stay whatever placeholders the
 * caller put in the text, inside text parts, for the caller to draw. No React and no Node, so client files import it.
 */
import type { Nodes, PhrasingContent, RootContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "bold"; children: Inline[] }
  | { kind: "italic"; children: Inline[] }
  | { kind: "struck"; children: Inline[] }
  | { kind: "code"; text: string }
  /** `href` only for http(s) and mailto; any other target is its text alone. */
  | { kind: "link"; href: string | null; children: Inline[] }
  /** A hard line break (a soft one, a newline inside a paragraph, stays in its text). */
  | { kind: "break" };

export type Align = "left" | "right" | "center" | null;

export type Block =
  | { kind: "paragraph"; content: Inline[] }
  | { kind: "heading"; depth: number; content: Inline[] }
  /** `start`: a numbered list's first number; a bullet list has none. Each item is blocks (a nested list among them). */
  | { kind: "list"; start: number | null; items: Block[][] }
  | { kind: "table"; align: Align[]; head: Inline[][]; rows: Inline[][][] }
  | { kind: "code"; text: string }
  | { kind: "quote"; children: Block[] }
  | { kind: "rule" };

/** A link's target, when it's one OpenDash follows: http(s) or mailto. Anything else (javascript:, data:) is null. */
export function safeHref(url: string): string | null {
  const href = url.trim();
  return /^(https?:\/\/|mailto:)\S/i.test(href) ? href : null;
}

const textOf = (node: Nodes): string =>
  "value" in node && typeof node.value === "string"
    ? node.value
    : "children" in node
      ? (node.children as Nodes[]).map(textOf).join("")
      : "";

function inlines(nodes: PhrasingContent[]): Inline[] {
  return nodes.flatMap((n): Inline[] => {
    switch (n.type) {
      case "text":
        return [{ kind: "text", text: n.value }];
      case "strong":
        return [{ kind: "bold", children: inlines(n.children) }];
      case "emphasis":
        return [{ kind: "italic", children: inlines(n.children) }];
      case "delete":
        return [{ kind: "struck", children: inlines(n.children) }];
      case "inlineCode":
        return [{ kind: "code", text: n.value }];
      case "break":
        return [{ kind: "break" }];
      case "link":
        return [{ kind: "link", href: safeHref(n.url), children: inlines(n.children) }];
      // Never drawn as HTML or an image: their own text.
      case "html":
        return [{ kind: "text", text: n.value }];
      case "image":
        return n.alt ? [{ kind: "text", text: n.alt }] : [];
      default:
        return textOf(n) ? [{ kind: "text", text: textOf(n) }] : [];
    }
  });
}

function blocks(nodes: RootContent[]): Block[] {
  return nodes.flatMap((n): Block[] => {
    switch (n.type) {
      case "paragraph":
        return [{ kind: "paragraph", content: inlines(n.children) }];
      case "heading":
        return [{ kind: "heading", depth: n.depth, content: inlines(n.children) }];
      case "list":
        return [
          {
            kind: "list",
            start: n.ordered ? (n.start ?? 1) : null,
            items: n.children.map((item) => blocks(item.children)),
          },
        ];
      case "table": {
        const [head, ...rows] = n.children;
        const cells = (row: (typeof n.children)[number] | undefined) =>
          (row?.children ?? []).map((c) => inlines(c.children));
        return [
          { kind: "table", align: (n.align ?? []).map((a) => a ?? null), head: cells(head), rows: rows.map(cells) },
        ];
      }
      case "code":
        return [{ kind: "code", text: n.value }];
      case "blockquote":
        return [{ kind: "quote", children: blocks(n.children) }];
      case "thematicBreak":
        return [{ kind: "rule" }];
      // Never drawn as HTML: its source, as a paragraph.
      case "html":
        return [{ kind: "paragraph", content: [{ kind: "text", text: n.value }] }];
      default: {
        const text = textOf(n);
        return text ? [{ kind: "paragraph", content: [{ kind: "text", text }] }] : [];
      }
    }
  });
}

/** An answer's markdown as blocks, the CommonMark way with GitHub's tables and strikethrough. */
export function parseMarkdown(source: string): Block[] {
  const tree = fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  return blocks(tree.children);
}

/** An answer's first table, taken out of its markdown (`takeTable`). */
export interface TakenTable {
  /** The markdown before it and after it, exactly as written. */
  before: string;
  after: string;
  align: Align[];
  /** Its cells as plain text, every row as wide as its header. */
  head: string[];
  rows: string[][];
  /**
   * Whether every cell says the same as plain text: false when one holds struck text (`~~12~~ 14` would read as a
   * current 12), a link whose words aren't its address (it would lose where it goes), or two marked pieces that would
   * run together into one number (`**12**_14_` as 1214).
   */
  flat: boolean;
}

/**
 * The first table at the top of an answer's markdown (not one inside a list or a quote), cut out where the parser found
 * it, so a channel can draw it its own way: the text around it is never rewritten. Null when there's none.
 */
export function takeTable(source: string): TakenTable | null {
  const tree = fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  const node = tree.children.find((n) => n.type === "table");
  const start = node?.position?.start.offset;
  const end = node?.position?.end.offset;
  if (node?.type !== "table" || start === undefined || end === undefined) return null;
  let flat = true;
  // A link says where it goes only when its text is its address (a bare one, as GFM finds them).
  const bare = (t: string) => t.replace(/^(https?:\/\/|mailto:)/i, "").replace(/\/$/, "");
  // A link whose target isn't followed (a relative one: its address could hold a value) says even less.
  const unsaid = (parts: Inline[]): boolean =>
    parts.some(
      (p) =>
        p.kind === "struck" ||
        (p.kind === "link" && (p.href === null || bare(plainText(p.children).trim()) !== bare(p.href))) ||
        ("children" in p && unsaid(p.children)),
    );
  // What the parse turns into its text alone, losing where it points: an image, a reference to a link or a note.
  const lost = (n: Nodes): boolean =>
    ["image", "imageReference", "linkReference", "footnoteReference"].includes(n.type) ||
    ("children" in n && (n.children as Nodes[]).some(lost));
  // The cell's pieces of text, a new one at every change of mark: where plain text would join two numbers.
  const pieces = (parts: Inline[], out: string[] = []): string[] => {
    for (const p of parts) {
      if (p.kind === "text" || p.kind === "code") out.push(p.text);
      else if (p.kind === "break") out.push("\n");
      else pieces(p.children, out);
    }
    return out;
  };
  const ends = new RegExp(`[\\p{N}${REF_CLOSE}]$`, "u");
  const starts = new RegExp(`^[\\p{N}${REF_OPEN}]`, "u");
  // Also within one piece: a value right beside another, or beside digits.
  const beside = new RegExp(`${REF_CLOSE}[\\p{N}${REF_OPEN}]|\\p{N}${REF_OPEN}`, "u");
  const joins = (parts: Inline[]) => {
    const ps = pieces(parts).filter((t) => t !== "");
    return ps.some((t, i) => beside.test(t) || (i > 0 && ends.test(ps[i - 1] ?? "") && starts.test(t)));
  };
  const cell = (c: (typeof node.children)[number]["children"][number]) => {
    const parts = inlines(c.children);
    if (unsaid(parts) || joins(parts) || c.children.some((n) => lost(n as Nodes))) flat = false;
    return plainText(parts).trim();
  };
  const [headRow, ...bodyRows] = node.children;
  const head = (headRow?.children ?? []).map(cell);
  const width = head.length;
  const row = (r: (typeof node.children)[number]) => {
    // A row wider than its header was cut by a `|` the parse took for a column (a Slack link's, say): its last cells
    // would be lost, so the table isn't flat.
    if (r.children.length > width) flat = false;
    const cells = r.children.slice(0, width).map(cell);
    return [...cells, ...Array<string>(width - cells.length).fill("")];
  };
  return {
    before: source.slice(0, start).trimEnd(),
    // Only the blank lines after it: an indented line keeps its indent (an indented code block stays code).
    after: source.slice(end).replace(/^(?:[ \t]*\r?\n)+/, ""),
    align: (node.align ?? []).map((a) => a ?? null),
    head,
    rows: bodyRows.map(row),
    flat,
  };
}

/** Whether markdown defines a link reference (`[g]: https://…`), which a link elsewhere in the text may use. */
export function hasDefinitions(source: string): boolean {
  const tree = fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  const found = (n: Nodes): boolean =>
    n.type === "definition" || ("children" in n && (n.children as Nodes[]).some(found));
  return found(tree);
}

/** Inline parts as plain text: marks dropped, a break a newline (for a cell's alignment, a caveat's chip). */
export function plainText(parts: Inline[]): string {
  return parts
    .map((p) => (p.kind === "text" || p.kind === "code" ? p.text : p.kind === "break" ? "\n" : plainText(p.children)))
    .join("");
}

/**
 * A reference (a gate-checked number) in an answer's text, as the page and the PDF put it there before parsing: its
 * index between two private-use characters the model can't type, so the parse never sees a number's display.
 */
export const REF_OPEN = "";
export const REF_CLOSE = "";

/** A cell that holds a number: digits, currency, percent and units around at most one reference. */
const NUMERIC_CELL = new RegExp(`^[\\s$€£%+\\-.,\\d]*(${REF_OPEN}\\d+${REF_CLOSE})?[\\s$€£%kMB+\\-.,\\d]*$`);

/**
 * Which columns of a table hold numbers, for aligning them right (the page and the PDF alike): every body cell a
 * number (or a reference among digits and units), or the column aligned right in the markdown itself. `rows` are the
 * cells as text, references as their placeholders. An empty body isn't numeric.
 */
export function numericColumns(table: { align: Align[]; head: unknown[]; rows: string[][] }): boolean[] {
  return table.head.map(
    (_, c) =>
      table.align[c] === "right" || (table.rows.length > 0 && table.rows.every((r) => NUMERIC_CELL.test(r[c] ?? ""))),
  );
}

/**
 * Text with no link that hides where it goes (for Slack, whose renderers make any link syntax a link): every link,
 * link reference, image and definition the parser finds becomes "text (address)", or the address alone when the text
 * already says it; a definition goes, its address shown where it's used. The source is rewritten where the parser
 * found each one, so nothing else in it changes. Then what the parser doesn't read as a link but Slack does: its own
 * `<url|label>` and `<url>`, written in sight the same way; and leftover `](` outside code, broken up.
 */
export function visibleLinks(source: string): string {
  const read = (text: string) => fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  // A link whose text is its own address (scheme and a trailing slash aside: a bare www.… or an email) is as it is.
  const bare = (t: string) => t.replace(/^(https?:\/\/|mailto:)/i, "").replace(/\/$/, "");
  const shown = (label: string, href: string | null) => {
    const l = label.replace(/\s+/g, " ").trim();
    if (!href) return l;
    if (!l) return href;
    return bare(l) === bare(href) ? l : `${l} (${href})`;
  };
  const span = (n: Nodes) => [n.position?.start.offset, n.position?.end.offset] as const;
  /** Where a text's code is (spans and blocks), so what's in it is left as written. */
  const codeIn = (text: string) => {
    const ranges: [number, number][] = [];
    const find = (n: Nodes) => {
      const [s, e] = span(n);
      if ((n.type === "code" || n.type === "inlineCode") && s !== undefined && e !== undefined) ranges.push([s, e]);
      if ("children" in n) for (const c of n.children as Nodes[]) find(c);
    };
    find(read(text));
    return (i: number) => ranges.some(([s, e]) => i >= s && i < e);
  };

  // First what no CommonMark parser reads as a link but Slack does: its own `<url|label>` (spaces and all) and `<url>`,
  // before the parser can take a piece of one for an address of its own. Again until nothing changes, since writing
  // an inner one out can leave an outer one whole (`<a|<b|c>>`); a few rounds at most.
  const slackLinks = (text: string) => {
    const inCode = codeIn(text);
    return text.replace(
      /<([^<>|\s]+)\|([^<>]*)>|<([a-z][a-z0-9+.-]*:[^<>\s|]*)>/gi,
      (m, href: string | undefined, label: string | undefined, bare: string | undefined, i: number) =>
        inCode(i) ? m : href !== undefined ? shown(label ?? "", href) : (bare ?? m),
    );
  };
  let slackFree = source;
  for (let round = 0; round < 8; round++) {
    const next = slackLinks(slackFree);
    if (next === slackFree) break;
    slackFree = next;
  }

  // Then every link, link reference, image and definition the parser finds, rewritten where it found it.
  const tree = read(slackFree);
  const definitions = new Map<string, string>();
  const collect = (n: Nodes) => {
    if (n.type === "definition") definitions.set(n.identifier, n.url);
    if ("children" in n) for (const c of n.children as Nodes[]) collect(c);
  };
  collect(tree);
  const edits: { start: number; end: number; text: string }[] = [];
  const walk = (n: Nodes) => {
    const [start, end] = span(n);
    const at = (text: string) => {
      if (start !== undefined && end !== undefined) edits.push({ start, end, text });
    };
    switch (n.type) {
      case "link":
        return at(shown(textOf(n), n.url));
      case "image":
        return at(shown(n.alt ?? "", n.url));
      case "linkReference":
        return at(shown(textOf(n), definitions.get(n.identifier) ?? null));
      case "imageReference":
        return at(shown(n.alt ?? "", definitions.get(n.identifier) ?? null));
      case "definition":
        return at("");
      case "code":
      case "inlineCode":
        return;
    }
    if ("children" in n) for (const c of n.children as Nodes[]) walk(c);
  };
  walk(tree);
  let out = slackFree;
  for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);

  // Last, whatever could still make a link for a renderer that reads it differently, outside code: `](`, `][` and
  // `]:` (a link, a reference, a definition) broken up with a space, and a word joiner (invisible) after every `<`
  // before a character, where no Slack link starts, whatever the rounds above left or rebuilt.
  const codeAtLast = codeIn(out);
  return out.replace(/\][([:]|<(?=\S)/g, (m, i: number) =>
    codeAtLast(i) ? m : m === "<" ? `<${JOINER}` : `] ${m.slice(1)}`,
  );
}

/** Invisible, and no Slack link syntax starts `<` + it. */
const JOINER = "\u2060";

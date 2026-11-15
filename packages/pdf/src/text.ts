/**
 * Text made ready for react-pdf's layout: what its line breaker and its fonts can't do
 * on their own. Pure, for tests.
 *
 * - **Where a long token may break.** react-pdf breaks lines at spaces only (and at hyphenation points, where it adds a
 *   "-"). A long address or ID has none, so it ran off the page. Such a token is cut after its separators (never
 *   between two, as in "//"), and `draw.ts` sets a space a hundredth of a point wide between the pieces: a break the
 *   line breaker takes like any space, invisible, and dropped at a line's end. An invisible character as the break
 *   (U+FEFF) isn't one: react-pdf puts a hyphenation point before it, and draws a "-" when it breaks there.
 * - **A number stays whole:** a table's number cell has no break at all, its spaces non-breaking.
 * - **Emoji as one glyph each:** the emoji font is monochrome; the marks that combine emoji into one (skin tones,
 *   keycaps, the joiner between two emoji) would draw as glyphs of their own, so they go.
 * - **A character no font has** (Chinese, Japanese and Korean aren't shipped) is drawn as "□". react-pdf's own last
 *   fallback is Helvetica, which turns such characters into overlapping Latin ones.
 * - **Code as written:** its lines broken at the column's width (Geist Mono is monospaced), its indentation kept.
 */

/** What a character no font has is drawn as. */
export const MISSING = "□";
const NBSP = "\u00A0";

/** A token longer than this, of printable ASCII (an address, an ID), may break inside; other scripts' words stay whole. */
const LONG = 24;
const LONG_TOKEN = new RegExp(`[\\x21-\\x7E]{${LONG + 1},}`, "g");
/** The longest stretch of a long token without a break point. */
const CHUNK = 12;
const CHUNKS = new RegExp(`.{1,${CHUNK}}`, "g");

/** Where a long token may break: after a separator that isn't followed by another. */
const AFTER_SEPARATOR = /(?<=[/?&=_.,;\-)\]])(?![/?&=_.,;\-)\]])/;

/** `text` in pieces, cut after each separator of a long token and inside any long stretch without one. */
export function breakable(text: string): string[] {
  const pieces = [""];
  let at = 0;
  for (const m of text.matchAll(LONG_TOKEN)) {
    const parts = m[0]
      .split(AFTER_SEPARATOR)
      .flatMap((piece) => (piece.length > CHUNK ? (piece.match(CHUNKS) ?? [piece]) : [piece]));
    pieces[pieces.length - 1] += text.slice(at, m.index) + (parts[0] ?? "");
    pieces.push(...parts.slice(1));
    at = m.index + m[0].length;
  }
  pieces[pieces.length - 1] += text.slice(at);
  return pieces;
}

/** A number cell's text on one line: its spaces non-breaking. */
export function unbreakable(text: string): string {
  return text.replace(/ /g, NBSP);
}

/** Marks that join emoji into one, which a monochrome font draws apart: skin tones, keycaps, variation selectors, tags. */
const EMOJI_MARKS = /(?:[\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}]|\uFE0E|\uFE0F)/gu;

/**
 * `text` as the fonts can draw it: emoji one glyph each, and a character none of them has as MISSING. Whitespace and
 * the joiners other scripts shape with (U+200C, U+200D) are kept.
 */
export function drawable(text: string, covers: (codePoint: number) => boolean): string {
  const plain = text
    .replace(/([0-9#*])\uFE0F?\u20E3/gu, "$1")
    .replace(EMOJI_MARKS, "")
    .replace(/\u200D(?=\p{Extended_Pictographic})/gu, "");
  let out = "";
  for (const ch of plain) {
    const cp = ch.codePointAt(0) ?? 0;
    const kept = cp < 0x20 || cp === 0x200c || cp === 0x200d || /\s/.test(ch) || covers(cp);
    out += kept ? ch : MISSING;
  }
  return out;
}

/**
 * A code block's text drawn as written: tabs as four spaces, each line broken every `perLine` characters (monospaced,
 * so that's where it meets the edge), and the leading spaces of each line non-breaking, which react-pdf would drop.
 */
export function codeText(text: string, perLine: number): string {
  const width = Math.max(1, Math.floor(perLine));
  return text
    .replace(/\t/g, "    ")
    .split("\n")
    .flatMap((line) => {
      const chars = [...line];
      if (chars.length <= width) return [line];
      const pieces: string[] = [];
      for (let i = 0; i < chars.length; i += width) pieces.push(chars.slice(i, i + width).join(""));
      return pieces;
    })
    .map((line) => line.replace(/^ +/, (lead) => NBSP.repeat(lead.length)))
    .join("\n");
}

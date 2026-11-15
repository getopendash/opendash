/**
 * Select to edit: where a piece of an App comes from, as the frame marks it (`data-od-src="/components/Queue.tsx:42:7"`),
 * and how a selection is named on its chip. Pure, with no imports, so the frame runtime, the page's client code and the
 * server all read a mark the same way.
 */

/** The most of an element's text a selection carries (whitespace collapsed). */
export const SELECTED_TEXT_MAX = 200;
/** An element's tag, as the frame reports it: a plain HTML or SVG name. */
export const SELECTED_TAG_MAX = 32;
/** The attribute the frame's JSX adapter stamps on each element an App draws. */
export const SOURCE_ATTRIBUTE = "data-od-src";

export interface SourceMark {
  /** One of the App's files: "/components/Queue.tsx". */
  file: string;
  line: number;
  column: number;
}

const MARK_MAX = 240;

/**
 * A mark's file, line and column, or null when it isn't one. The mark comes from a frame whose App code could write
 * anything there, so its shape is checked piece by piece: a path of plain names under the App's root with an App
 * file's extension, then two whole numbers. Whether the file is really one of the App's is the server's check.
 */
export function parseSourceMark(mark: unknown): SourceMark | null {
  if (typeof mark !== "string" || mark.length > MARK_MAX) return null;
  const parts = mark.split(":");
  if (parts.length !== 3) return null;
  const [file = "", lineText = "", columnText = ""] = parts;
  if (!/^\d{1,6}$/.test(lineText) || !/^\d{1,6}$/.test(columnText)) return null;
  const line = Number(lineText);
  if (line < 1) return null;
  if (!file.startsWith("/") || !/\.(tsx|ts)$/.test(file)) return null;
  const names = file.slice(1).split("/");
  if (names.length > 3 || !names.every((n) => /^[\w.-]{1,72}$/.test(n) && !n.startsWith("."))) return null;
  return { file, line, column: Number(columnText) };
}

/** An element's text as a selection carries it: whitespace collapsed, at most SELECTED_TEXT_MAX characters. */
export const selectedText = (text: unknown): string =>
  typeof text === "string" ? text.replace(/\s+/g, " ").trim().slice(0, SELECTED_TEXT_MAX) : "";

/** A file's name without its folders or extension: what a chip calls the piece when nothing better is known. */
export const fileStem = (file: string) => (file.split("/").at(-1) ?? file).replace(/\.(tsx|ts)$/, "");

/**
 * A selection's chip, in the person's words: "‘#4656 urgent’ in Queue", what the piece shows and where. The file and
 * line are the agent's (given with the lines around them), not the chip's. The component is the file's name; the text
 * is cut short for the chip.
 */
export function selectionLabel(s: { file: string; text?: string | null; component?: string | null }) {
  const text = selectedText(s.text ?? "");
  const shown = text.length > 32 ? `${text.slice(0, 31)}…` : text;
  const where = s.component || fileStem(s.file);
  return shown ? `‘${shown}’ in ${where}` : where;
}

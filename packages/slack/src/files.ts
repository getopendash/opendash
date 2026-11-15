/**
 * The file reader: what someone attaches to a question in Slack, read by OpenDash's own bounded reader.
 * Text and Markdown only, judged by content (strict UTF-8, no NUL bytes), at most 1 MB a file and 3 a message. Nothing
 * in a file is run; the analyst gets its text fenced as the asker's data. CSV isn't read in v0.
 */
import { MAX_FILE_TEXT, MAX_FILES } from "@opendash/core";

export const MAX_FILE_BYTES = 1024 * 1024;

/** What Chat SDK gives for an attachment (its `fetchData` downloads it, the bot token only to Slack's own hosts). */
export interface IncomingFile {
  name?: string;
  /** Where the file is: only Slack's own file host is ever fetched. */
  url?: string;
  mimeType?: string;
  size?: number;
  fetchData?: () => Promise<Buffer | ArrayBuffer>;
}

export interface ReadFiles {
  /** The files read, as the analyst will see them. */
  read: { name: string; text: string }[];
  /** What to tell the person: a file not read and why, or one cut. */
  notes: string[];
}

const TEXT_EXTENSIONS = new Set(["txt", "text", "md", "markdown"]);
const TEXT_TYPES = new Set(["text/plain", "text/markdown", "text/x-markdown"]);
const REFUSED = "I read text and Markdown files, up to 1 MB each.";

/** A plain name: the last path part, no control characters, at most 120 characters. */
export function plainName(name: string | undefined): string {
  const base = (name ?? "").split(/[/\\]/).pop() ?? "";
  const clean = [...base]
    .filter((c) => c.charCodeAt(0) >= 32)
    .join("")
    .trim();
  return (clean || "file").slice(0, 120);
}

/** Cuts UTF-8 text to at most `bytes`, on a character boundary. */
export function cutText(text: string, bytes: number): { text: string; cut: boolean } {
  const encoded = new TextEncoder().encode(text);
  if (encoded.byteLength <= bytes) return { text, cut: false };
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(encoded.slice(0, bytes));
  return { text: decoded.replace(/�+$/, ""), cut: true };
}

/**
 * Whether a file's address is Slack's own file host (https://files.slack.com). Nothing else is fetched: a message can
 * name any address, and fetching it would let a message make OpenDash read an internal one.
 */
export function isSlackFile(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === "files.slack.com" && !u.username && !u.password && !u.port;
  } catch {
    return false;
  }
}

/** Reads one file, or says why it wasn't read. */
export async function readFile(file: IncomingFile): Promise<{ name: string; text?: string; note?: string }> {
  const name = plainName(file.name);
  const extension = name.includes(".") ? name.split(".").pop()?.toLowerCase() : undefined;
  const type = file.mimeType?.split(";")[0]?.trim().toLowerCase();
  const looksText = extension ? TEXT_EXTENSIONS.has(extension) : Boolean(type && TEXT_TYPES.has(type));
  if (!looksText) return { name, note: `${name} wasn't read: ${REFUSED}` };
  if ((file.size ?? 0) > MAX_FILE_BYTES) return { name, note: `${name} wasn't read: it's over 1 MB.` };
  if (!file.fetchData || !isSlackFile(file.url)) {
    return { name, note: `${name} wasn't read: it isn't a file shared in Slack.` };
  }
  const raw = await file.fetchData();
  const bytes =
    raw instanceof ArrayBuffer ? new Uint8Array(raw) : new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  if (bytes.byteLength > MAX_FILE_BYTES) return { name, note: `${name} wasn't read: it's over 1 MB.` };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { name, note: `${name} wasn't read: it isn't plain text.` };
  }
  if (text.includes("\u0000")) return { name, note: `${name} wasn't read: it isn't plain text.` };
  const kept = cutText(text, MAX_FILE_TEXT);
  return kept.cut
    ? { name, text: kept.text, note: `Only the first ${MAX_FILE_TEXT / 1024} KB of ${name} were read.` }
    : { name, text: kept.text };
}

/** Reads a message's files, at most three; the rest are named as not read. */
export async function readFiles(files: IncomingFile[]): Promise<ReadFiles> {
  const read: ReadFiles["read"] = [];
  const notes: string[] = [];
  for (const [i, file] of files.entries()) {
    if (i >= MAX_FILES) {
      notes.push(`${plainName(file.name)} wasn't read: I read up to ${MAX_FILES} files a message.`);
      continue;
    }
    const r = await readFile(file);
    if (r.text !== undefined) read.push({ name: r.name, text: r.text });
    if (r.note) notes.push(r.note);
  }
  return { read, notes };
}

/**
 * The reference reader: what a person attaches to a question in OpenDash, read by OpenDash's own
 * bounded reader. Text, Markdown, CSV, TSV and JSON as they are; HTML as its words (scripts and styles dropped, never
 * run); PDF as its text (pdf.js, no rendering, no scripts); PNG, JPEG, GIF and WebP images as themselves, for the model
 * to look at (a PDF in a process of its own). Judged by content as well as name; at most a few megabytes. The analyst gets text fenced as the asker's
 * data and images as the asker's own pictures: nothing in a file is ever an instruction.
 */
import { execFile, spawn } from "node:child_process";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { MAX_FILE_TEXT } from "./attachments";

/** The most a file may be, as uploaded. */
export const MAX_REFERENCE_BYTES = 8 * 1024 * 1024;
/** The most an image may be: what the model is sent. */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_PDF_PAGES = 40;
/** The most time a PDF's text is read for. */
const PDF_MS = 15_000;

export type ImageType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export type ReadReference =
  | { kind: "file"; name: string; text: string; note?: string }
  | { kind: "image"; name: string; mediaType: ImageType; data: string }
  | { kind: "refused"; name: string; note: string };

/** A plain name: the last path part, no control characters, at most 120 characters. */
export function plainName(name: string | undefined): string {
  const base = (name ?? "").split(/[/\\]/).pop() ?? "";
  const clean = [...base]
    .filter((c) => c.charCodeAt(0) >= 32)
    .join("")
    .trim();
  return (clean || "file").slice(0, 120);
}

/** What an image is, from its first bytes (never from its name alone). */
export function imageType(b: Uint8Array): ImageType | null {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  if (
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

/** The most memory a PDF's reading may take (its process's resident memory): past it, the process is killed. */
const PDF_MEMORY_MB = 512;
/** PDFs read at once on this server: more wait their turn (inside their time). */
const PDF_AT_ONCE = 2;

/**
 * Reads a PDF's text in a process of its own (pdf.js, no scripts, no rendering), with no secrets in its environment,
 * killed past PDF_MEMORY_MB of memory or PDF_MS of time whatever it's doing: a crafted PDF can't take the server's
 * memory or time. The bytes go in on stdin, the text comes out on stdout as JSON. unpdf is loaded there by name, from
 * the server's own packages.
 */
const PDF_PROCESS = String.raw`
const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", async () => {
  let out;
  try {
    const { maxPages, maxText, unpdf } = JSON.parse(process.argv[1]);
    const { getDocumentProxy } = await import(unpdf);
    const pdf = await getDocumentProxy(new Uint8Array(Buffer.concat(chunks)), { isEvalSupported: false, maxImageSize: 1048576 });
    const pages = Math.min(pdf.numPages, maxPages);
    const texts = [];
    let length = 0;
    for (let p = 1; p <= pages; p++) {
      if (length > maxText) break;
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      const t = content.items.map((it) => ("str" in it ? it.str + (it.hasEOL ? "\n" : "") : "")).join("");
      texts.push(t);
      length += t.length;
    }
    out = JSON.stringify({ ok: true, text: texts.join("\n\n").slice(0, maxText * 2), pages: texts.length, numPages: pdf.numPages });
  } catch {
    out = JSON.stringify({ ok: false });
  }
  // Exits once all of it is written: a pipe takes 64 KB at a time.
  process.stdout.write(out, () => process.exit(0));
});
`;

type PdfRead =
  | { ok: true; text: string; pages: number; numPages: number }
  | { ok: false; why: "bad" | "slow" | "large" };

/** A process's resident memory in MB, or null when it can't be read. */
async function residentMb(pid: number): Promise<number | null> {
  try {
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    const kb = /VmRSS:\s+(\d+)/.exec(status)?.[1];
    return kb ? Number(kb) / 1024 : null;
  } catch {
    return new Promise((resolve) =>
      execFile("ps", ["-o", "rss=", "-p", String(pid)], { timeout: 1000 }, (error, out) =>
        resolve(error ? null : Number(out.trim()) / 1024 || null),
      ),
    );
  }
}

let reading = 0;
/** Reads waiting for a slot, first come first served: a freed slot is handed to the next, never left for a third. */
const queue: (() => void)[] = [];

/** A slot to read in, within `ms`; false when none came in time (and the wait is gone from the queue). */
function take(ms: number): Promise<boolean> {
  if (reading < PDF_AT_ONCE) {
    reading++;
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const handed = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      const i = queue.indexOf(handed);
      if (i >= 0) queue.splice(i, 1);
      resolve(false);
    }, ms);
    queue.push(handed);
  });
}

/** Gives the slot to the next waiting read, or frees it. */
function give() {
  const next = queue.shift();
  if (next) next();
  else reading--;
}

/** A PDF's text, read in its own capped process. */
export async function pdfText(
  bytes: Uint8Array,
  /** Tighter limits, or (tests) the process's own code. */
  limits: { ms?: number; memoryMb?: number; code?: string } = {},
): Promise<PdfRead> {
  const started = Date.now();
  const ms = limits.ms ?? PDF_MS;
  const unpdf = await unpdfEntry();
  if (!limits.code && !unpdf) return { ok: false, why: "bad" };
  if (!(await take(ms))) return { ok: false, why: "slow" };
  try {
    return await readInProcess(
      bytes,
      ms - (Date.now() - started),
      limits.memoryMb ?? PDF_MEMORY_MB,
      unpdf ?? "",
      limits.code,
    );
  } finally {
    give();
  }
}

/**
 * Where unpdf's entry is, found once: the server's own node_modules (development, tests), or the copy a production
 * build ships under a hashed name in .next/node_modules. Importing it here (never given a file) also tells the build to
 * ship it. Null: not installed, and PDFs aren't read.
 */
let located: Promise<string | null> | null = null;
const unpdfEntry = () => {
  located ??= import("unpdf").then(
    () => {
      const roots = [path.join(process.cwd(), "node_modules", "unpdf")];
      try {
        const built = path.join(process.cwd(), ".next", "node_modules");
        for (const name of readdirSync(built))
          if (/^unpdf(-[0-9a-f]+)?$/.test(name)) roots.push(path.join(built, name));
      } catch {
        // No production build here.
      }
      for (const root of roots) {
        try {
          const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
            name?: string;
            exports?: { ".": { default?: string } };
          };
          const entry = pkg.name === "unpdf" ? pkg.exports?.["."]?.default : undefined;
          if (entry) return pathToFileURL(path.join(realpathSync(root), entry)).href;
        } catch {
          // Not this one.
        }
      }
      return null;
    },
    () => null,
  );
  return located;
};

function readInProcess(
  bytes: Uint8Array,
  ms: number,
  memoryMb: number,
  unpdf: string,
  code?: string,
): Promise<PdfRead> {
  return new Promise((resolve) => {
    let done = false;
    let out = "";
    const child = spawn(
      process.execPath,
      [
        `--max-old-space-size=${Math.min(memoryMb, 256)}`,
        "-e",
        code ?? PDF_PROCESS,
        JSON.stringify({ maxPages: MAX_PDF_PAGES, maxText: MAX_FILE_TEXT, unpdf }),
      ],
      // No secrets: only what finds the server's packages.
      {
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? "", NODE_ENV: "production" } as NodeJS.ProcessEnv,
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
    const finish = (r: PdfRead) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(watch);
      if (child.exitCode === null) child.kill("SIGKILL");
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, why: "slow" }), Math.max(1, ms));
    // Its memory, looked at every 100 ms; memory that can't be read three times running is taken as too much.
    let unread = 0;
    const watch = setInterval(async () => {
      const mb = child.pid ? await residentMb(child.pid) : null;
      if (done) return;
      unread = mb === null ? unread + 1 : 0;
      if ((mb !== null && mb > memoryMb) || unread >= 3) finish({ ok: false, why: "large" });
    }, 100);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c: string) => {
      out += c;
      if (out.length > MAX_FILE_TEXT * 4) finish({ ok: false, why: "large" });
    });
    child.on("error", () => finish({ ok: false, why: "bad" }));
    child.on("close", () => {
      try {
        const r = JSON.parse(out) as PdfRead | { ok: false };
        finish(r.ok ? (r as PdfRead) : { ok: false, why: "bad" });
      } catch {
        // Killed by the system (out of memory) or a crash: nothing it said is read.
        finish({ ok: false, why: "bad" });
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(Buffer.from(bytes));
  });
}

const isPdf = (b: Uint8Array) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46; // %PDF

/** Text, cut to what's kept (on a character boundary), with a note when it was cut. */
function kept(text: string): { text: string; note?: string } {
  const encoded = new TextEncoder().encode(text);
  if (encoded.byteLength <= MAX_FILE_TEXT) return { text };
  const cut = new TextDecoder("utf-8", { fatal: false }).decode(encoded.slice(0, MAX_FILE_TEXT)).replace(/�+$/, "");
  return { text: cut, note: `Only its first ${MAX_FILE_TEXT / 1024} KB of text were read.` };
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** The most HTML read: past it, the page is cut (stripping stays linear, and no page is worth more). */
const MAX_HTML_CHARS = 2 * 1024 * 1024;

/**
 * Drops each block of these tags, and comments, by scanning forward (indexOf), never a backtracking pattern: one
 * opened and never closed drops the rest of the page.
 */
function dropBlocks(html: string): string {
  const lower = html.toLowerCase();
  const opens = ["<!--", "<script", "<style", "<noscript", "<template", "<svg", "<head"];
  // Each marker's next place, searched again only once the scan has passed it; one never found stays gone. Every
  // search moves forward, so the pass is linear in the page.
  const next = new Map<string, number>(opens.map((o) => [o, lower.indexOf(o)]));
  let out = "";
  let at = 0;
  for (;;) {
    let first = -1;
    let which = "";
    for (const o of opens) {
      let i = next.get(o) ?? -1;
      if (i >= 0 && i < at) {
        i = lower.indexOf(o, at);
        next.set(o, i);
      }
      if (i >= 0 && (first < 0 || i < first)) {
        first = i;
        which = o;
      }
    }
    if (first < 0) return out + html.slice(at);
    out += `${html.slice(at, first)} `;
    const close = which === "<!--" ? "-->" : `</${which.slice(1)}`;
    const end = lower.indexOf(close, first + which.length);
    if (end < 0) return out;
    const gt = which === "<!--" ? end + 2 : lower.indexOf(">", end);
    if (gt < 0) return out;
    at = gt + 1;
  }
}

/** An HTML page's words: scripts, styles and comments dropped, tags turned into breaks, entities read. */
export function htmlText(html: string): string {
  return dropBlocks(html.slice(0, MAX_HTML_CHARS))
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/section|\/article)\b[^>]*>/gi, "\n")
    .replace(/<\/t[dh]\s*>/gi, " | ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const code = e[1]?.toLowerCase() === "x" ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1));
        return Number.isFinite(code) && code > 31 && code < 0x110000 ? String.fromCodePoint(code) : " ";
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Strict UTF-8 with no NUL: text, or null. */
function utf8(b: Uint8Array): string | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(b);
    return text.includes("\u0000") ? null : text;
  } catch {
    return null;
  }
}

const TEXT_EXTENSIONS = new Set(["txt", "text", "md", "markdown", "csv", "tsv", "json", "log"]);
const HTML_EXTENSIONS = new Set(["html", "htm"]);
const REFUSED = "OpenDash reads text, Markdown, CSV, JSON, HTML and PDF files, and PNG, JPEG, GIF and WebP images.";

/** Reads one reference, or says why it wasn't read. */
export async function readReference(input: { name: string; bytes: Uint8Array }): Promise<ReadReference> {
  const name = plainName(input.name);
  const b = input.bytes;
  if (!b.byteLength) return { kind: "refused", name, note: `${name} is empty.` };
  if (b.byteLength > MAX_REFERENCE_BYTES) {
    return { kind: "refused", name, note: `${name} is over ${MAX_REFERENCE_BYTES / 1024 / 1024} MB.` };
  }
  const extension = name.includes(".") ? (name.split(".").pop()?.toLowerCase() ?? "") : "";
  const image = imageType(b);
  if (image) {
    if (b.byteLength > MAX_IMAGE_BYTES) {
      return {
        kind: "refused",
        name,
        note: `${name} is over ${MAX_IMAGE_BYTES / 1024 / 1024} MB: send a smaller image.`,
      };
    }
    return { kind: "image", name, mediaType: image, data: Buffer.from(b).toString("base64") };
  }
  if (isPdf(b)) {
    const read = await pdfText(b);
    if (!read.ok) {
      return {
        kind: "refused",
        name,
        note:
          read.why === "slow"
            ? `${name} took too long to read: send fewer pages, or its pages as images.`
            : read.why === "large"
              ? `${name} needs more memory to read than OpenDash gives a file: send fewer pages.`
              : `${name} couldn't be read as a PDF (damaged, or locked with a password).`,
      };
    }
    const text = read.text
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (!text)
      return { kind: "refused", name, note: `${name} has no text to read (a scan): send its pages as images.` };
    const k = kept(text);
    const more =
      read.numPages > read.pages ? `Only its first ${read.pages} of ${read.numPages} pages were read.` : undefined;
    const note = [more, k.note].filter(Boolean).join(" ") || undefined;
    return { kind: "file", name, text: k.text, ...(note ? { note } : {}) };
  }
  const text = utf8(b);
  if (text === null) return { kind: "refused", name, note: `${name} wasn't read: ${REFUSED}` };
  const looksHtml = HTML_EXTENSIONS.has(extension) || /^\s*(<!doctype html|<html[\s>])/i.test(text.slice(0, 200));
  if (looksHtml) {
    const words = htmlText(text);
    if (!words) return { kind: "refused", name, note: `${name} has no words to read.` };
    const k = kept(words);
    return { kind: "file", name, text: k.text, ...(k.note ? { note: k.note } : {}) };
  }
  if (extension && !TEXT_EXTENSIONS.has(extension)) {
    return { kind: "refused", name, note: `${name} wasn't read: ${REFUSED}` };
  }
  const k = kept(text);
  return { kind: "file", name, text: k.text, ...(k.note ? { note: k.note } : {}) };
}

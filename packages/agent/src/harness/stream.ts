/**
 * What a run streams while it works: the model's thinking as it's written, the answer's text as the answer
 * tool's input arrives, and that a query is being written. Nothing else: plain text (only the answer tool's text
 * reaches the person), provisional tool calls and step requests (they carry the prompt) are never written. Numbers in
 * the answer's text stay unchecked until the gate passes them, so the web shows each as a grey pill until then.
 *
 * The parts are coalesced: one `delta` event per flush, at least FLUSH_MS apart or FLUSH_CHARS long, at most
 * MAX_DELTAS per run. A model call's own deltas are flushed before its message is committed; any that reach us after
 * that (the stream runs a little behind the call) are dropped, so a later live row never shows an earlier call's text.
 */

/** Coalescing bounds. */
export const FLUSH_MS = 200;
export const FLUSH_CHARS = 1024;
export const MAX_DELTAS = 300;
/** The most text one flush carries of each kind; past it a flush is cut short (the committed message has it all). */
export const FLUSH_MAX_CHARS = 8 * 1024;

/** The query tools: their start shows as "Writing a query". */
const QUERY_TOOLS = new Set(["sql_query", "metric_query"]);
/** Tools whose writing is a step of its own while its input streams: a dashboard's save. */
const BUILD_TOOLS = new Set(["dashboard_save", "dashboard_page"]);

const ESCAPES: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

/**
 * The value of one top-level string field of a JSON object, as its text arrives in pieces (a tool's input, streamed):
 * each `feed` returns the field's newly decoded characters. Escapes split across pieces decode once whole; other
 * fields, nested objects and arrays (a chart's own fields) are skipped. Never parses partial JSON as a whole.
 */
export class FieldStream {
  private depth = 0;
  private inString = false;
  private escape = false;
  private unicode: string | null = null;
  /** The string being read is a key of the top-level object, or that object's field's value. */
  private readingKey = false;
  private capturing = false;
  private expectingKey = false;
  private afterColon = false;
  private key = "";
  private lastKey = "";
  private done = false;

  constructor(private readonly field: string) {}

  feed(chunk: string): string {
    let out = "";
    const emit = (c: string) => {
      if (this.readingKey) this.key += c;
      else if (this.capturing) out += c;
    };
    for (const ch of chunk) {
      if (this.inString) {
        if (this.unicode !== null) {
          this.unicode += ch;
          if (this.unicode.length === 4) {
            const code = Number.parseInt(this.unicode, 16);
            this.unicode = null;
            if (!Number.isNaN(code)) emit(String.fromCharCode(code));
          }
          continue;
        }
        if (this.escape) {
          this.escape = false;
          if (ch === "u") this.unicode = "";
          else emit(ESCAPES[ch] ?? ch);
          continue;
        }
        if (ch === "\\") {
          this.escape = true;
          continue;
        }
        if (ch === '"') {
          this.inString = false;
          if (this.readingKey) {
            this.lastKey = this.key;
            this.readingKey = false;
          } else if (this.capturing) {
            this.capturing = false;
            this.done = true;
          }
          continue;
        }
        emit(ch);
        continue;
      }
      if (ch === '"') {
        this.inString = true;
        this.readingKey = this.depth === 1 && this.expectingKey;
        if (this.readingKey) this.key = "";
        this.capturing =
          !this.readingKey && this.depth === 1 && this.afterColon && this.lastKey === this.field && !this.done;
        this.afterColon = false;
        this.expectingKey = false;
      } else if (ch === "{" || ch === "[") {
        this.depth += 1;
        this.expectingKey = ch === "{" && this.depth === 1;
        this.afterColon = false;
      } else if (ch === "}" || ch === "]") {
        this.depth -= 1;
        if (this.depth === 1) this.expectingKey = false;
      } else if (ch === ":") {
        if (this.depth === 1) this.afterColon = true;
      } else if (ch === ",") {
        if (this.depth === 1) {
          this.expectingKey = true;
          this.afterColon = false;
        }
      }
    }
    return out;
  }
}

/** One flush: thinking and answer text since the last one, a new answer, and the queries being written. */
export interface DeltaData {
  thinking?: string;
  /** The answer call this text belongs to, and the text: a new call's draft starts over. */
  answer?: { callId: string; text: string };
  /** Query calls whose input started: "Writing a query". */
  writing?: string[];
  /** Dashboard saves whose input started: "Writing the dashboard". */
  building?: string[];
  /** What a dashboard save is writing, as far as it's arrived: its pages' and sections' ids and titles. */
  outline?: { callId: string; items: { id: string; title: string }[] }[];
  /** What an App's save is writing, as far as it's arrived: the manifest, each file and each edit, in order. */
  files?: { callId: string; items: SaveItem[] }[];
}

/** One thing an App's save writes: the manifest, a whole file (and its lines so far), or an edit to one. */
export interface SaveItem {
  kind: "manifest" | "write" | "edit" | "remove";
  path?: string;
  lines?: number;
}

/** Where a scan of partial JSON is: an object (its key, once read) or an array. */
type Frame = { kind: "object"; key: string | null; awaitingKey: boolean } | { kind: "array" };

/** A JSON string starting at \`at\` (its opening quote): where it ends, whether it closed, and its escaped newlines. */
function scanString(input: string, at: number): { end: number; closed: boolean; newlines: number } {
  let newlines = 0;
  for (let i = at + 1; i < input.length; i += 1) {
    if (input[i] === "\\") {
      if (input[i + 1] === "n") newlines += 1;
      i += 1;
    } else if (input[i] === '"') return { end: i + 1, closed: true, newlines };
  }
  return { end: input.length, closed: false, newlines };
}

/**
 * The manifest, files and edits an App's save input names so far, in the order they arrive, so the chat never says
 * only "Writing the dashboard" for a minute. It follows the input's structure as far as it
 * has arrived: \`definition\` or \`set\` at the top is the manifest; each key of \`files\` a file written (its lines so
 * far) or removed (null); each of \`edits\`' \`file\` an edit. No path is guessed from its shape.
 */
export function saveItemsOf(input: string): SaveItem[] {
  const items: SaveItem[] = [];
  const stack: Frame[] = [];
  const keyAt = (depth: number) => {
    const f = stack[depth];
    return f?.kind === "object" ? f.key : null;
  };
  const inFiles = () => stack.length === 2 && keyAt(0) === "files";
  const inEdit = () => stack.length === 3 && keyAt(0) === "edits" && stack[1]?.kind === "array";
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    const top = stack.at(-1);
    if (c === "{") stack.push({ kind: "object", key: null, awaitingKey: true });
    else if (c === "[") stack.push({ kind: "array" });
    else if (c === "}" || c === "]") stack.pop();
    else if (c === "," && top?.kind === "object") {
      top.key = null;
      top.awaitingKey = true;
    } else if (c === '"') {
      const str = scanString(input, i);
      if (top?.kind === "object" && top.awaitingKey) {
        if (!str.closed) break;
        top.key = JSON.parse(input.slice(i, str.end)) as string;
        top.awaitingKey = false;
        if (
          stack.length === 1 &&
          (top.key === "definition" || top.key === "set") &&
          !items.some((x) => x.kind === "manifest")
        )
          items.push({ kind: "manifest" });
      } else if (inFiles() && top?.kind === "object" && top.key) {
        items.push({ kind: "write", path: top.key, lines: str.newlines + 1 });
      } else if (inEdit() && top?.kind === "object" && top.key === "file" && str.closed) {
        const path = JSON.parse(input.slice(i, str.end)) as string;
        if (!items.some((x) => x.kind === "edit" && x.path === path)) items.push({ kind: "edit", path });
      }
      i = str.end;
      continue;
    } else if (input.startsWith("null", i) && inFiles() && top?.kind === "object" && top.key) {
      items.push({ kind: "remove", path: top.key });
      i += 4;
      continue;
    }
    i += 1;
  }
  return items;
}

/**
 * The pages and sections a dashboard save's input names so far: every object (as far as it has arrived) with a
 * page's or section's id (`p_…`, `s_…`) and a title, whichever order its fields come in. A light scan of partial JSON:
 * strings and nesting are followed, nothing else is parsed.
 */
export function outlineOf(input: string): { id: string; title: string }[] {
  const out = new Map<string, string>();
  const stack: { id?: string; title?: string; key?: string }[] = [];
  let i = 0;
  const readString = (): string | null => {
    // At an opening quote: the string's value, or null when it hasn't all arrived.
    let j = i + 1;
    let raw = "";
    while (j < input.length) {
      const c = input[j];
      if (c === "\\") {
        if (j + 1 >= input.length) return null;
        raw += c + input[j + 1];
        j += 2;
        continue;
      }
      if (c === '"') {
        i = j + 1;
        try {
          return JSON.parse(`"${raw}"`) as string;
        } catch {
          return raw;
        }
      }
      raw += c;
      j += 1;
    }
    return null;
  };
  const settle = (o: { id?: string; title?: string }) => {
    // By characters, never mid-pair: half an emoji would stop every later delta (jsonb refuses it).
    if (o.id && o.title && /^(?:p|s)_[a-z0-9_]{1,40}$/.test(o.id))
      out.set(o.id, Array.from(o.title.trim()).slice(0, 80).join(""));
  };
  while (i < input.length) {
    const c = input[i];
    if (c === "{") {
      stack.push({});
      i += 1;
    } else if (c === "}") {
      stack.pop();
      i += 1;
    } else if (c === '"') {
      const top = stack[stack.length - 1];
      const value = readString();
      if (value === null) break;
      // A key (followed by a colon), or a value of the key before it.
      let k = i;
      while (k < input.length && /\s/.test(input[k] ?? "")) k += 1;
      if (input[k] === ":") {
        if (top) top.key = value;
        i = k + 1;
      } else if (top?.key === "id" || top?.key === "title") {
        top[top.key] = value;
        top.key = undefined;
        settle(top);
      } else if (top) top.key = undefined;
    } else {
      // A non-string value ends its key.
      if (c === "," || c === "[") {
        const top = stack[stack.length - 1];
        if (top) top.key = undefined;
      }
      i += 1;
    }
  }
  return [...out].map(([id, title]) => ({ id, title })).slice(0, 60);
}

/** At most this much of a dashboard save's input is read for its outline. */
const OUTLINE_CHARS = 200_000;

/** A stream part, as far as the coalescer reads it (the AI SDK's TextStreamPart). */
export type StreamPart =
  | { type: "start-step" }
  | { type: "reasoning-delta"; text: string }
  | { type: "tool-input-start"; id: string; toolName: string }
  | { type: "tool-input-delta"; id: string; delta: string }
  | { type: string };

/** Splits off a trailing high surrogate, which jsonb would refuse alone; it goes out with its pair. */
function whole(text: string): [string, string] {
  const last = text.charCodeAt(text.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? [text.slice(0, -1), text.slice(-1)] : [text, ""];
}

/** Flushes kept for the answer's text: thinking alone stops this short of the run's cap. */
export const ANSWER_RESERVE = 60;

/**
 * Coalesces one run's stream into `delta` events. `write` appends one (fenced to the attempt); a failed write stops
 * the deltas, never the run. `written` is what earlier attempts of the run already wrote: the cap is the run's.
 */
export class RunDeltas {
  private thinking = "";
  private answerText = "";
  private answerCall: string | null = null;
  private writing: string[] = [];
  private building: string[] = [];
  /** Dashboard saves' input so far, and how many names each had at the last flush. */
  private buildInput = new Map<string, string>();
  private outlined = new Map<string, number>();
  /** Each App save's items as last flushed, so a flush sends them only when they changed. */
  private itemized = new Map<string, string>();
  private answerFields = new Map<string, FieldStream>();
  private lastFlush = 0;
  /** Steps whose start the stream has shown, and model calls whose message was committed. */
  private started = 0;
  private ended = 0;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly write: (data: DeltaData) => Promise<void>,
    private readonly now: () => number = Date.now,
    private written = 0,
  ) {}

  /** Reads one part of the stream; flushes when enough has gathered, or soon after it stops arriving. */
  part(p: StreamPart): void {
    if (this.stopped) return;
    if (p.type === "start-step") {
      this.started += 1;
      return;
    }
    // A part of a call whose message is already committed (the stream runs behind the call): dropped.
    if (this.started <= this.ended) return;
    if (p.type === "reasoning-delta" && "text" in p) {
      this.thinking += p.text;
    } else if (p.type === "tool-input-start" && "toolName" in p) {
      if (p.toolName === "answer") {
        this.flushAnswerCall();
        this.answerCall = p.id;
        this.answerFields.set(p.id, new FieldStream("markdown"));
      } else if (QUERY_TOOLS.has(p.toolName)) {
        this.writing.push(p.id);
      } else if (BUILD_TOOLS.has(p.toolName)) {
        this.building.push(p.id);
        this.buildInput.set(p.id, "");
      }
    } else if (p.type === "tool-input-delta" && "delta" in p) {
      const field = this.answerFields.get(p.id);
      if (field && p.id === this.answerCall) this.answerText += field.feed(p.delta);
      const built = this.buildInput.get(p.id);
      if (built !== undefined && built.length < OUTLINE_CHARS) this.buildInput.set(p.id, built + p.delta);
    } else {
      return;
    }
    const pending = this.thinking.length + this.answerText.length;
    if (this.now() - this.lastFlush >= FLUSH_MS || pending >= FLUSH_CHARS) this.flush();
    else this.arm();
  }

  /** The model call ended: what it streamed is written before its message is committed, the rest dropped. */
  async endCall(): Promise<void> {
    this.flush();
    this.ended += 1;
    await this.chain;
  }

  /** The stream is over (or failed): whatever's pending goes out, and the last write lands. */
  async settle(): Promise<void> {
    this.flush();
    await this.chain;
  }

  /** No more deltas (the run is ending): waits for the last write. */
  async close(): Promise<void> {
    this.stopped = true;
    this.disarm();
    await this.chain;
  }

  /** A flush soon after the last part, so a pause in the stream never holds back what came before it. */
  private arm(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.started > this.ended) this.flush();
    }, FLUSH_MS);
    this.timer.unref?.();
  }

  private disarm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** An answer call's text goes out before another's starts, so the two never mix in one flush. */
  private flushAnswerCall(): void {
    if (this.answerCall && this.answerText) this.flush();
  }

  private flush(): void {
    this.disarm();
    if (this.stopped) return;
    const [thinking, heldThinking] = whole(this.thinking.slice(0, FLUSH_MAX_CHARS));
    const [answer, heldAnswer] = whole(this.answerText.slice(0, FLUSH_MAX_CHARS));
    // A dashboard save's outline, when it has named something new since the last flush.
    const outline = [...this.buildInput].flatMap(([callId, text]) => {
      const items = outlineOf(text);
      if (items.length <= (this.outlined.get(callId) ?? 0)) return [];
      this.outlined.set(callId, items.length);
      return [{ callId, items }];
    });
    // An App save's files as they arrive, and each one's lines so far.
    const files = [...this.buildInput].flatMap(([callId, text]) => {
      const items = saveItemsOf(text);
      const sig = JSON.stringify(items);
      if (!items.length || this.itemized.get(callId) === sig) return [];
      this.itemized.set(callId, sig);
      return [{ callId, items }];
    });
    const data: DeltaData = {
      ...(thinking ? { thinking } : {}),
      ...(answer && this.answerCall ? { answer: { callId: this.answerCall, text: answer } } : {}),
      ...(this.writing.length ? { writing: this.writing } : {}),
      ...(this.building.length ? { building: this.building } : {}),
      ...(outline.length ? { outline } : {}),
      ...(files.length ? { files } : {}),
    };
    // What was cut short stays out (the committed message has it); a held surrogate waits for its pair.
    this.thinking = this.thinking.length > FLUSH_MAX_CHARS ? "" : heldThinking;
    this.answerText = this.answerText.length > FLUSH_MAX_CHARS ? "" : heldAnswer;
    this.writing = [];
    this.building = [];
    if (!Object.keys(data).length) return;
    this.lastFlush = this.now();
    // The run's cap, with the last flushes kept for the answer's text, the part people wait for.
    if (this.written >= MAX_DELTAS || (!data.answer && this.written >= MAX_DELTAS - ANSWER_RESERVE)) return;
    this.written += 1;
    this.chain = this.chain
      .then(() => this.write(data))
      .catch(() => {
        // A delta is a convenience: losing the fence or the database stops the deltas, and the run says why itself.
        this.stopped = true;
      });
  }
}

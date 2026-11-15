// A stand-in for Slack's Web API (FakeSlack), for tests that run the real Chat SDK adapter: it answers
// every method the bot and the reply call with what Slack would (`ok`, a message's ts), and records each call with
// its arguments, so a test asserts what was said to Slack. It keeps the messages posted (with their metadata) so a
// thread can be read back, as a resumed reply looks for what it may have posted. The adapter points at it with its
// `apiUrl`.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeCall {
  method: string;
  args: Record<string, unknown>;
}

/** A message in the fake's Slack, as `conversations.replies` gives it back. */
export interface FakeMessage {
  channel: string;
  ts: string;
  /** Who posted it: the bot (U0BOT) for whatever came through the API. */
  user?: string;
  /** The poster's team, as Slack gives it on a person's message. */
  team?: string;
  thread_ts?: string;
  text?: string;
  metadata?: { event_type: string; event_payload: Record<string, unknown> };
}

export interface FakeSlack {
  /** Slack's API address as the adapter takes it (ends in a slash). */
  url: string;
  calls: FakeCall[];
  messages: FakeMessage[];
  /** The calls to one method. */
  of(method: string): FakeCall[];
  /**
   * Answers a method differently (a refusal, say): what to answer with (`ok: false` and an `error` for a refusal), or
   * null to answer this call as usual; `answer(method, null)` goes back to the default for good.
   */
  answer(method: string, reply: ((args: Record<string, unknown>) => Record<string, unknown> | null) | null): void;
  close(): Promise<void>;
}

/** Slack's form arguments, each JSON object or list (blocks, metadata) read back as JSON; the rest as sent. */
function argsOf(body: string, contentType: string | undefined): Record<string, unknown> {
  if (contentType?.includes("application/json")) return body ? (JSON.parse(body) as Record<string, unknown>) : {};
  const args: Record<string, unknown> = {};
  for (const [k, v] of new URLSearchParams(body)) {
    try {
      args[k] = /^[[{]/.test(v) ? JSON.parse(v) : v;
    } catch {
      args[k] = v;
    }
  }
  return args;
}

const textOf = (a: Record<string, unknown>) =>
  typeof a.markdown_text === "string" ? a.markdown_text : typeof a.text === "string" ? a.text : undefined;

export async function fakeSlack(): Promise<FakeSlack> {
  const calls: FakeCall[] = [];
  const messages: FakeMessage[] = [];
  const answers = new Map<string, (args: Record<string, unknown>) => Record<string, unknown> | null>();
  let ts = 1_791_800_000;
  let files = 0;
  const nextTs = () => `${++ts}.000100`;
  let base = "";
  const post = (a: Record<string, unknown>) => {
    const message: FakeMessage = {
      channel: String(a.channel),
      ts: nextTs(),
      user: "U0BOT",
      ...(typeof a.thread_ts === "string" ? { thread_ts: a.thread_ts } : {}),
      ...(textOf(a) === undefined ? {} : { text: textOf(a) }),
      ...(a.metadata ? { metadata: a.metadata as FakeMessage["metadata"] } : {}),
    };
    messages.push(message);
    return message;
  };
  const defaults: Record<string, (args: Record<string, unknown>) => Record<string, unknown>> = {
    "chat.postMessage": (a) => {
      const m = post(a);
      return { channel: m.channel, ts: m.ts, message: { text: m.text ?? "" } };
    },
    "chat.postEphemeral": () => ({ message_ts: nextTs() }),
    "chat.update": (a) => ({ channel: a.channel, ts: a.ts }),
    "chat.startStream": (a) => {
      const m = post({ channel: a.channel, thread_ts: a.thread_ts });
      return { channel: m.channel, ts: m.ts };
    },
    "chat.stopStream": (a) => {
      const m = messages.find((x) => x.channel === a.channel && x.ts === a.ts);
      if (m) {
        if (textOf(a) !== undefined) m.text = `${m.text ?? ""}${textOf(a)}`;
        if (a.metadata) m.metadata = a.metadata as FakeMessage["metadata"];
      }
      return { channel: a.channel, ts: a.ts };
    },
    "conversations.replies": (a) => ({
      messages: messages
        .filter((m) => m.channel === a.channel && (m.ts === a.ts || m.thread_ts === a.ts))
        .map((m) =>
          a.include_all_metadata === true || a.include_all_metadata === "true" ? m : { ...m, metadata: undefined },
        ),
      has_more: false,
    }),
    "conversations.history": (a) => ({ messages: messages.filter((m) => m.channel === a.channel), has_more: false }),
    "users.info": (a) => ({ user: { id: a.user, name: "priya", real_name: "Priya Raman", profile: {} } }),
    "conversations.info": (a) => ({ channel: { id: a.channel, is_im: String(a.channel).startsWith("D") } }),
    "auth.test": () => ({ user_id: "U0BOT", team_id: "T0ACME", bot_id: "B0BOT" }),
    "files.getUploadURLExternal": () => {
      files += 1;
      return { upload_url: `${base}upload/${files}`, file_id: `F${files}` };
    },
    "files.completeUploadExternal": (a) => ({
      files: (Array.isArray(a.files) ? a.files : []).map((f: { id?: string; title?: string }) => ({
        id: f.id,
        title: f.title,
      })),
    }),
  };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const path = (req.url ?? "").replace(/^\/+/, "").replace(/\?.*$/, "");
      // A file's bytes, sent to the address files.getUploadURLExternal gave.
      if (path.startsWith("upload/")) {
        calls.push({ method: "upload", args: { path, bytes: Buffer.concat(chunks).length } });
        res.end("OK");
        return;
      }
      const args = argsOf(Buffer.concat(chunks).toString("utf8"), req.headers["content-type"]);
      calls.push({ method: path, args });
      const usual = defaults[path] ?? (() => ({}));
      const answer = answers.get(path)?.(args) ?? usual(args);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, ...answer }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}/`;
  return {
    url: base,
    calls,
    messages,
    of: (method) => calls.filter((c) => c.method === method),
    answer: (method, reply) => {
      if (reply) answers.set(method, reply);
      else answers.delete(method);
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

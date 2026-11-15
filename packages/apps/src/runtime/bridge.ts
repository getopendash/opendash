// The frame side of the bridge: JSON-RPC 2.0 over postMessage, in MCP Apps' shape. The frame has no network, so every
// read goes through the OpenDash page around it. Replies are accepted only from that page (the parent window).
import { FRAME_METHODS } from "../protocol";

// From a random start: a reply meant for an earlier document in this frame (it reloaded) never matches a request here.
let nextId = Math.floor(Math.random() * 2 ** 40);
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const parent = window.parent;
const post = parent.postMessage.bind(parent);

window.addEventListener("message", (e) => {
  if (e.source !== parent) return;
  const m = e.data as { jsonrpc?: string; id?: number; result?: unknown; error?: { message: string } };
  if (m?.jsonrpc !== "2.0" || typeof m.id !== "number") return;
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  if (m.error) p.reject(new Error(m.error.message));
  else p.resolve(m.result);
});

export function callTool<T>(name: string, args: unknown): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    post({ jsonrpc: "2.0", id, method: FRAME_METHODS.call, params: { name, arguments: args } }, "*");
  });
}

export function notify(method: string, params: unknown): void {
  post({ jsonrpc: "2.0", method, params }, "*");
}

export const mark = (name: string) => notify(FRAME_METHODS.mark, { name, t: Math.round(performance.now()) });

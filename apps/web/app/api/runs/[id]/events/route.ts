import { getRun, runEvents } from "@opendash/core";
import { isUuid, type TenantTx, withTenant } from "@opendash/db";
import { currentViewer } from "@/lib/auth";
import { runHub } from "@/lib/run-stream";

export const dynamic = "force-dynamic";

const deps = { withTenant: <T>(orgId: string, fn: (tx: TenantTx) => Promise<T>) => withTenant({ orgId }, fn) };
const ENDED = new Set(["succeeded", "failed", "cancelled"]);
/** Doc 11: a stream is recycled about every 5 minutes (proxies), and the browser reconnects with Last-Event-ID. */
const RECYCLE_MS = 5 * 60_000;
const PING_MS = 15_000;
/** A safety read while listening (a lost notify), or the poll without a LISTEN connection (500 ms). */
const SAFETY_MS = 5_000;
const POLL_MS = 500;

/**
 * A run's events as server-sent events (Streaming): `run_event` (id = seq) for each new event, `status` when
 * the run's status changes, and `end` once it has ended. Only for someone who can see the run's thread. Reconnecting
 * with Last-Event-ID = N replays the events after N.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const viewer = await currentViewer();
  if (viewer.kind !== "tenant") return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  if (!isUuid(id)) return Response.json({ error: "not found" }, { status: 404 });
  const who = { orgId: viewer.ctx.orgId, userId: viewer.user.id };
  // Owners and admins follow background work too (a drafting batch).
  const follows = { manages: viewer.role === "owner" || viewer.role === "admin" };
  const first = await getRun(deps, who, id, follows);
  if (!first) return Response.json({ error: "not found" }, { status: 404 });

  const resume = Number(request.headers.get("last-event-id") ?? new URL(request.url).searchParams.get("after") ?? 0);
  const encoder = new TextEncoder();
  let close = () => {};

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let last = Number.isInteger(resume) && resume > 0 ? resume : 0;
      let status = "";
      let closed = false;
      let reading = false;
      let again = false;
      const timers: ReturnType<typeof setInterval>[] = [];
      let recycle: ReturnType<typeof setTimeout> | undefined;
      const send = (chunk: string) => {
        if (!closed) controller.enqueue(encoder.encode(chunk));
      };
      const event = (name: string, data: unknown, seq?: number) =>
        send(`${seq !== undefined ? `id: ${seq}\n` : ""}event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
      let unsubscribe = () => {};
      close = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        for (const t of timers) clearInterval(t);
        clearTimeout(recycle);
        try {
          controller.close();
        } catch {
          // Already closed by the client.
        }
      };
      // Reads what's new since `last`; a wake during a read reads once more, so nothing is missed or sent twice.
      const read = async () => {
        if (reading) {
          again = true;
          return;
        }
        reading = true;
        try {
          do {
            again = false;
            const run = await getRun(deps, who, id, follows);
            if (!run) return close();
            for (const e of await runEvents(deps, who, id, last, follows)) {
              event(
                "run_event",
                {
                  seq: e.seq,
                  attempt: e.attempt,
                  type: e.type,
                  data: e.data,
                  createdAt: new Date(e.created_at).toISOString(),
                },
                e.seq,
              );
              last = e.seq;
            }
            if (run.status !== status) {
              status = run.status;
              event("status", { status });
            }
            if (ENDED.has(run.status)) {
              event("end", { status: run.status });
              return close();
            }
          } while (again && !closed);
        } catch {
          close();
        } finally {
          reading = false;
        }
      };

      // Subscribe before the first read, so an event committed in between wakes a second read.
      unsubscribe = runHub.subscribe(id, () => void read());
      request.signal.addEventListener("abort", close);
      send("retry: 1000\n\n");
      const listening = await runHub.start();
      timers.push(setInterval(() => void read(), listening ? SAFETY_MS : POLL_MS));
      timers.push(setInterval(() => send(": ping\n\n"), PING_MS));
      recycle = setTimeout(close, RECYCLE_MS);
      await read();
    },
    cancel() {
      close();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

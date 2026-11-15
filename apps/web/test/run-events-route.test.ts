// A run's events as server-sent events (Streaming), with the run's reads and the LISTEN hub stood in. Only a
// signed-in member who can see the run gets them; each event carries its seq as the stream's id, so a reconnect with
// Last-Event-ID replays only what came after; a notify reads what's new; a run that ended says so and the stream ends.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const viewer = vi.hoisted(() => ({ current: null as unknown }));
const core = vi.hoisted(() => ({ getRun: vi.fn(), runEvents: vi.fn() }));
const hub = vi.hoisted(() => ({
  wakes: [] as (() => void)[],
  subscribe: vi.fn((_id: string, wake: () => void) => {
    hub.wakes.push(wake);
    return () => {};
  }),
  start: vi.fn(async () => true),
}));

vi.mock("@/lib/auth", () => ({ currentViewer: async () => viewer.current }));
vi.mock("@/lib/run-stream", () => ({ runHub: hub }));
vi.mock("@opendash/core", async (actual) => ({ ...(await actual<object>()), ...core }));
vi.mock("@opendash/db", async (actual) => ({
  ...(await actual<object>()),
  withTenant: async (_ctx: unknown, fn: (tx: unknown) => Promise<unknown>) => fn({}),
}));

const route = await import("../app/api/runs/[id]/events/route");

const RUN = "0190a000-0000-7000-8000-000000000001";
const member = { kind: "tenant", ctx: { orgId: "org-1" }, user: { id: "user-1" }, role: "member" };
const params = (id = RUN) => ({ params: Promise.resolve({ id }) });
const ev = (seq: number) => ({
  seq,
  attempt: 1,
  type: "text",
  data: { text: `part ${seq}` },
  created_at: "2026-10-19",
});

/** Everything the stream says until it ends. */
async function readAll(res: Response): Promise<string> {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return text;
    text += decoder.decode(value);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  hub.wakes.length = 0;
  viewer.current = member;
});

describe("a run's event stream", () => {
  it("is for a signed-in member who can see the run, and no one else", async () => {
    viewer.current = { kind: "signed-out" };
    expect((await route.GET(new Request("http://x/api/runs/r/events"), params())).status).toBe(401);
    viewer.current = member;
    expect((await route.GET(new Request("http://x/api/runs/r/events"), params("not-a-run"))).status).toBe(404);
    core.getRun.mockResolvedValueOnce(null);
    expect((await route.GET(new Request("http://x/api/runs/r/events"), params())).status).toBe(404);
  });

  it("sends each event with its seq as its id, then the status, then the end, and closes", async () => {
    core.getRun.mockResolvedValue({ status: "succeeded" });
    core.runEvents.mockResolvedValueOnce([ev(1), ev(2)]);
    const res = await route.GET(new Request(`http://x/api/runs/${RUN}/events`), params());
    expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store, no-transform");
    const text = await readAll(res);
    expect(text.startsWith("retry: 1000\n\n")).toBe(true);
    expect(text).toContain("id: 1\nevent: run_event\n");
    expect(text).toContain("id: 2\nevent: run_event\n");
    expect(text.indexOf("event: status")).toBeGreaterThan(text.indexOf("id: 2"));
    expect(text.trimEnd().endsWith('event: end\ndata: {"status":"succeeded"}')).toBe(true);
  });

  it("replays only what came after the last event a reconnect saw", async () => {
    core.getRun.mockResolvedValue({ status: "failed" });
    core.runEvents.mockResolvedValueOnce([ev(8)]);
    const res = await route.GET(
      new Request(`http://x/api/runs/${RUN}/events`, { headers: { "last-event-id": "7" } }),
      params(),
    );
    await readAll(res);
    expect(core.runEvents).toHaveBeenCalledWith(expect.anything(), { orgId: "org-1", userId: "user-1" }, RUN, 7, {
      manages: false,
    });
  });

  it("reads what's new when the hub says the run moved, and ends when it has", async () => {
    core.getRun.mockResolvedValueOnce({ status: "running" }).mockResolvedValueOnce({ status: "running" });
    core.runEvents.mockResolvedValueOnce([ev(1)]).mockResolvedValueOnce([ev(2)]);
    const res = await route.GET(new Request(`http://x/api/runs/${RUN}/events`), params());
    const reading = readAll(res);
    await vi.waitFor(() => expect(core.runEvents).toHaveBeenCalledTimes(1));
    expect(hub.subscribe).toHaveBeenCalledWith(RUN, expect.any(Function));
    core.getRun.mockResolvedValue({ status: "succeeded" });
    core.runEvents.mockResolvedValue([]);
    for (const wake of hub.wakes) wake();
    const text = await reading;
    // Event 2 once, from the read the notify started; never event 1 again.
    expect(text.match(/id: 1\n/g)).toHaveLength(1);
    expect(text.match(/id: 2\n/g)).toHaveLength(1);
    // The notify's read asked only for what came after event 1.
    expect(core.runEvents).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), RUN, 1, expect.anything());
    expect(text).toContain("event: end");
  });
});

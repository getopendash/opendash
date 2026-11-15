import { freshDatabase, type TestDatabase } from "@opendash/db/testing";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBoss, workDraining } from "../src/jobs/boss";

// A queue someone waits on drains at the speed of its slots: pg-boss's slots each took one job per wake-up
// and then slept until the next poll, 30 s while wake-ups are on, so an App of 13 queries had 5 of them wait 30 s.

let t: TestDatabase;
let worker: PgBoss;
let producer: PgBoss;

beforeAll(async () => {
  t = await freshDatabase();
  worker = createBoss(t.url("opendash_queue"), "worker", { supervise: false, schedule: false });
  await worker.start();
  producer = createBoss(t.url("opendash_queue"), "producer");
  await producer.start();
}, 60_000);

afterAll(async () => {
  await producer?.stop({ graceful: false });
  await worker?.stop({ graceful: false });
  await t?.drop();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A queue someone waits on (notify), with jobs that take `ms` each; when each started, from the moment they were sent. */
async function burst(name: string, count: number, ms: number, slots: number) {
  await worker.createQueue(name, { notify: true, retryLimit: 1, retryDelay: 1 });
  const started: number[] = [];
  let sentAt = 0;
  await workDraining<{ i: number }>(worker, { name }, { slots }, async () => {
    started.push(performance.now() - sentAt);
    await sleep(ms);
  });
  // One open of an App: its queries are put in line together, so they make one wake-up.
  sentAt = performance.now();
  await producer.insert(
    name,
    Array.from({ length: count }, (_, i) => ({ data: { i } })),
  );
  const deadline = Date.now() + 20_000;
  while (started.length < count && Date.now() < deadline) await sleep(20);
  return started;
}

describe("a queue someone waits on", () => {
  it("starts a backlog larger than its slots as slots free, with no second wake-up", async () => {
    // 13 queries, 8 slots, 300 ms each: the last 5 start when the first 8 are done, not at the next poll.
    const started = await burst("test.drain.app", 13, 300, 8);
    expect(started).toHaveLength(13);
    expect(Math.max(...started)).toBeLessThan(1_500);
  }, 30_000);

  it("drains a long backlog at the speed of its slots", async () => {
    // 60 jobs on 4 slots at 100 ms: about 1.5 s of work, finished well before one 2 s backstop poll would allow.
    const started = await burst("test.drain.backlog", 60, 100, 4);
    expect(started).toHaveLength(60);
    expect(Math.max(...started)).toBeLessThan(3_000);
  }, 30_000);

  it("starts a backlog that was waiting before the worker started, and never runs more than its slots at once", async () => {
    const name = "test.drain.before";
    await worker.createQueue(name, { notify: true });
    // Put in line while no worker is there (a deploy): nothing will wake anyone for these.
    await producer.insert(
      name,
      Array.from({ length: 30 }, (_, i) => ({ data: { i } })),
    );
    let running = 0;
    let most = 0;
    const seen = new Set<number>();
    const startedAt = performance.now();
    await workDraining<{ i: number }>(worker, { name }, { slots: 4 }, async ([job]) => {
      if (!job) return;
      running += 1;
      most = Math.max(most, running);
      await sleep(50);
      seen.add(job.data.i);
      running -= 1;
    });
    const deadline = Date.now() + 15_000;
    while (seen.size < 30 && Date.now() < deadline) await sleep(20);
    // Every job, once each, 4 at a time at most; the first poll finds them, then the slots drain the rest.
    expect([...seen].sort((a, b) => a - b)).toEqual(Array.from({ length: 30 }, (_, i) => i));
    expect(most).toBeLessThanOrEqual(4);
    expect(performance.now() - startedAt).toBeLessThan(4_000);
  }, 30_000);

  it("still runs a retry, which sends no wake-up, within its delay and one backstop poll", async () => {
    const name = "test.drain.retry";
    await worker.createQueue(name, { notify: true, retryLimit: 1, retryDelay: 1 });
    let tries = 0;
    let doneAt = 0;
    const sentAt = performance.now();
    await workDraining(worker, { name }, { slots: 2 }, async () => {
      tries += 1;
      if (tries === 1) throw new Error("the first try fails");
      doneAt = performance.now() - sentAt;
    });
    await producer.send(name, {});
    const deadline = Date.now() + 15_000;
    while (!doneAt && Date.now() < deadline) await sleep(50);
    expect(tries).toBe(2);
    // 1 s retry delay, then at most one 2 s backstop poll.
    expect(doneAt).toBeLessThan(4_500);
  }, 30_000);

  it("gives the handler when its job was put in line and when it started", async () => {
    const name = "test.drain.meta";
    await worker.createQueue(name, { notify: true });
    let waited: number | null = null;
    await workDraining(worker, { name }, { slots: 1, includeMetadata: true }, async ([job]) => {
      if (job) waited = job.startedOn.getTime() - job.createdOn.getTime();
    });
    await producer.send(name, {});
    const deadline = Date.now() + 10_000;
    while (waited === null && Date.now() < deadline) await sleep(20);
    expect(waited).not.toBeNull();
    expect(waited).toBeGreaterThanOrEqual(0);
    expect(waited).toBeLessThan(2_000);
  }, 30_000);
});

/**
 * pg-boss, in the pgboss schema owned by opendash_queue. pg-boss always gets its own pool.
 *   - The web app holds a producer: no supervision, no schedules, no migrations. It enqueues inside the caller's
 *     tenant transaction, so a row and the job for it commit together or not at all.
 *   - Workers run the full instance, which also detects dead workers (heartbeats) and expires stuck jobs.
 */
import type { TenantTx } from "@opendash/db";
import { type SQL, sql } from "@opendash/db";
import {
  type ConstructorOptions,
  type Db,
  PgBoss,
  type SendOptions,
  type WorkHandlerFor,
  type WorkOptions,
} from "pg-boss";
import { BUDGETS } from "../budgets";
import { loggableError } from "../loggable";
import { QUEUES, type QueueDefinition } from "./queues";

export const QUEUE_SCHEMA = "pgboss";

/** Turns pg-boss's positional SQL ($1, $2, …) into a drizzle statement, so it runs inside our transaction. */
export function toDrizzleSql(text: string, values: unknown[] = []): SQL {
  const chunks: SQL[] = [];
  let last = 0;
  for (const match of text.matchAll(/\$(\d+)\b/g)) {
    chunks.push(sql.raw(text.slice(last, match.index)));
    chunks.push(sql`${values[Number(match[1]) - 1] ?? null}`);
    last = (match.index ?? 0) + match[0].length;
  }
  chunks.push(sql.raw(text.slice(last)));
  return sql.join(chunks, sql.raw(""));
}

/** A pg-boss `db` that executes in the given tenant transaction. */
export function transactionDb(tx: TenantTx): Db {
  return {
    async executeSql(text, values) {
      const rows = await tx.execute(toDrizzleSql(text, values));
      return { rows: [...rows] };
    },
  };
}

export type QueueRole = "producer" | "worker";

export function createBoss(url: string, role: QueueRole, extra: Partial<ConstructorOptions> = {}): PgBoss {
  const common: ConstructorOptions = {
    connectionString: url,
    schema: QUEUE_SCHEMA,
    application_name: `opendash-${role}-queue`,
    createSchema: false,
  };
  const options: ConstructorOptions =
    role === "producer"
      ? { ...common, max: 2, supervise: false, schedule: false, migrate: false, registerInstance: false }
      : {
          ...common,
          max: 4,
          migrate: true,
          // Wakes workers the moment a job is sent on a queue marked notify (someone waiting: an App's answer, a
          // question's run), instead of after a poll of up to two seconds, which made queries feel slow.
          // It holds one session connection for LISTEN: the worker's URL is a direct one, never through PgBouncer.
          useListenNotify: true,
          superviseIntervalSeconds: BUDGETS.queue.superviseIntervalSeconds,
          monitorIntervalSeconds: BUDGETS.queue.monitorIntervalSeconds,
        };
  const boss = new PgBoss({ ...options, ...extra });
  // pg-boss reports background errors as events; an unhandled 'error' event would crash the process.
  boss.on("error", (error) => console.error(JSON.stringify({ msg: "queue error", role, error: loggableError(error) })));
  return boss;
}

/**
 * Creates or updates every queue, and lets opendash_app enqueue: USAGE on the schema, SELECT and INSERT on its
 * tables, now and for tables pg-boss creates later. Runs as opendash_queue, the owner, from `pnpm db:migrate` and at
 * worker start. Idempotent.
 */
export async function installQueues(boss: PgBoss): Promise<void> {
  for (const queue of QUEUES) {
    const existing = await boss.getQueue(queue.name);
    if (existing) await boss.updateQueue(queue.name, updatable(queue.options));
    else await boss.createQueue(queue.name, queue.options);
  }
  const db = boss.getDb();
  await db.executeSql(`
    grant usage on schema ${QUEUE_SCHEMA} to opendash_app;
    grant select, insert on all tables in schema ${QUEUE_SCHEMA} to opendash_app;
    alter default privileges in schema ${QUEUE_SCHEMA} grant select, insert on tables to opendash_app;
  `);
}

/** updateQueue doesn't take the policy or partition, which are fixed when a queue is created. */
function updatable(options: QueueDefinition<unknown>["options"]) {
  const { policy: _policy, partition: _partition, ...rest } = options;
  return rest;
}

/** Enqueues a job in the caller's transaction: if the transaction rolls back, the job never existed. */
export async function enqueue<T extends object>(
  boss: PgBoss,
  tx: TenantTx,
  queue: QueueDefinition<T>,
  data: T,
  options: Omit<SendOptions, "db"> = {},
): Promise<string> {
  const id = await boss.send(queue.name, data, { ...options, db: transactionDb(tx) });
  if (!id) throw new Error(`${queue.name}: the queue refused the job`);
  return id;
}

/**
 * Enqueues a job on a queue that keeps one per key (`stately`: one waiting; `exclusive`: one waiting or at work), in
 * the caller's transaction. Null means one is there already, and it does this job's work too (a definitions check
 * tests everything unchecked; a Slack reply posts whatever isn't posted yet).
 */
export async function enqueueOnce<T extends object>(
  boss: PgBoss,
  tx: TenantTx,
  queue: QueueDefinition<T>,
  data: T,
  options: Omit<SendOptions, "db"> & { singletonKey: string },
): Promise<string | null> {
  return boss.send(queue.name, data, { ...options, db: transactionDb(tx) });
}

/** How often a draining slot looks at its queue when nothing woke it: for what sends no wake-up (a retry's delayed start). */
const BACKSTOP_SECONDS = 2;

/**
 * Works a queue someone is waiting on as `slots` workers that each fetch again the moment their job is done, sleeping
 * only when the queue had nothing for them. pg-boss's own slots (`localConcurrency`) fetch one job, run it, then sleep
 * until their next poll, 30 s while wake-ups are on: one wake-up started 8 jobs and an App's other 5 queries waited 30 s.
 * Each slot is its own worker so it can wake itself (`notifyWorker` takes one worker's id, and
 * `work` returns only the first slot's). A slot that just finished a job fetches at once; a short poll stays for what
 * sends no wake-up, such as a retry's delayed start.
 */
export async function workDraining<T, const O extends Omit<WorkOptions, "localConcurrency"> = Record<never, never>>(
  boss: PgBoss,
  queue: { name: string; readonly payload?: T },
  options: O & { slots: number },
  handler: WorkHandlerFor<O, T>,
): Promise<string[]> {
  const { slots, ...rest } = options;
  const ids: string[] = [];
  for (let i = 0; i < slots; i++) {
    let id: string | undefined;
    const wrapped = (async (jobs: Parameters<typeof handler>[0]) => {
      try {
        return await (handler as (jobs: unknown) => Promise<unknown>)(jobs);
      } finally {
        if (id) boss.notifyWorker(id);
      }
    }) as WorkHandlerFor<O, T>;
    id = await boss.work<T, unknown, O>(
      queue.name,
      {
        ...(rest as unknown as O),
        localConcurrency: 1,
        pollingIntervalSeconds: BACKSTOP_SECONDS,
        notifyPollingIntervalSeconds: BACKSTOP_SECONDS,
      },
      wrapped,
    );
    ids.push(id);
  }
  return ids;
}

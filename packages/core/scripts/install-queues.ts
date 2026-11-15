import path from "node:path";
import { loadRootEnv } from "../../../scripts/load-env.mjs";
import { createBoss, installQueues } from "../src/jobs/boss";

// Part of `pnpm db:migrate`: installs or upgrades pg-boss in the pgboss schema and creates the queues. Workers do the
// same at start, so this only matters before the first worker runs (the web app enqueues into these tables).
loadRootEnv(path.resolve(import.meta.dirname, "../../.."));

const url = process.env.DATABASE_QUEUE_URL;
if (!url) throw new Error("Set DATABASE_QUEUE_URL (opendash_queue, direct connection) to install the queues.");
const boss = createBoss(url, "worker", { supervise: false, schedule: false, registerInstance: false });
await boss.start();
await installQueues(boss);
await boss.stop({ graceful: false });
console.info("queues installed");

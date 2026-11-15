// The operator's view: when the dispatcher last ran, the open alerts (the deployment's and every
// organization's), and each queue's waiting and active jobs. As the system role: it's for whoever runs the
// deployment, never a tenant.
//
//   pnpm --filter @opendash/worker ops [--all]   (--all: alerts resolved in the last 7 days too)
import path from "node:path";
import { parseArgs } from "node:util";
import { createBoss, QUEUES, tickIsLate } from "@opendash/core";
import { closeDatabases, sql, withSystem } from "@opendash/db";
import { loadRootEnv } from "../../../scripts/load-env.mjs";

loadRootEnv(path.resolve(import.meta.dirname, "../../.."));
const { values } = parseArgs({ options: { all: { type: "boolean", default: false } } });

const ago = (d: Date) => {
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  return s < 120 ? `${s} s ago` : s < 7200 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
};

const [tick] = await withSystem((tx) =>
  tx.execute<{ at: string; result: Record<string, number> }>(sql`
    select at, result from app.ops_tick where name = 'system.tick'`),
);
const at = tick ? new Date(tick.at) : null;
console.log(
  at
    ? `Dispatcher: ran ${ago(at)}${tickIsLate(at) ? " (LATE: is a worker running?)" : ""} · last found ${JSON.stringify(tick?.result)}`
    : "Dispatcher: has never run (is a worker running?)",
);

const alerts = await withSystem((tx) =>
  tx.execute<{
    org: string | null;
    kind: string;
    subject: string;
    message: string;
    count: number;
    last_seen_at: string;
    resolved_at: string | null;
  }>(sql`
    select o.name as org, a.kind, a.subject, a.message, a.count, a.last_seen_at, a.resolved_at
    from app.ops_alert a left join app.org o on o.id = a.org_id
    where a.resolved_at is null ${values.all ? sql`or a.resolved_at > now() - interval '7 days'` : sql``}
    order by a.resolved_at is not null, a.last_seen_at desc limit 100`),
);
console.log(`\nAlerts (${alerts.filter((a) => !a.resolved_at).length} open):`);
for (const a of alerts) {
  console.log(
    `  ${a.resolved_at ? "resolved" : "OPEN    "} ${a.kind.padEnd(18)} ${(a.org ?? "deployment").padEnd(20)} ×${a.count}  ${ago(new Date(a.last_seen_at))}  ${a.subject}`,
  );
  console.log(`           ${a.message}`);
}
if (!alerts.length) console.log("  none");

const queueUrl = process.env.DATABASE_QUEUE_URL;
if (queueUrl) {
  const boss = createBoss(queueUrl, "producer");
  await boss.start();
  const stats = await boss.getQueues(QUEUES.map((q) => q.name));
  console.log("\nQueues (waiting · active · deferred):");
  for (const q of stats.sort((a, b) => a.name.localeCompare(b.name))) {
    const flag = q.name.endsWith(".dlq") && q.queuedCount > 0 ? "  ← dead letters waiting" : "";
    console.log(`  ${q.name.padEnd(26)} ${q.readyCount} · ${q.activeCount} · ${q.deferredCount}${flag}`);
  }
  await boss.stop({ graceful: false });
}
await closeDatabases();
process.exit(0);

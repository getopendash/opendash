/**
 * A row's actions: a change in a service, made from a dashboard by the person pressing
 * it, with their own account, once they confirm exactly what will be sent.
 *
 * - **Prepare** builds the call from the revision the page draws (nothing the page sends but ids and the row's key),
 *   checks it as the executor would (the server and the tool allowed in dashboards, the tool not one that only reads,
 *   the arguments fitting its schema, the person's own account ready) and writes it as an effect: who, what, the
 *   account and the tool's digest as shown. The ticket lasts two minutes.
 * - **Run** claims the ticket once (`prepared` → `running`) before anything is sent; the executor checks the account
 *   and the tool are still the ones confirmed, and sends it once. The effect settles `done`, `failed`, or `unknown`
 *   when no answer came (never sent again: "check in Jira"). A ticket run again reads how it settled.
 * - A service read from a dashboard row must have that key in the read the page shows.
 */
import { createHash } from "node:crypto";
import { isServiceDataset } from "@opendash/apps/dashboard";
import { actionKey, fillAction } from "@opendash/apps/dashboard/actions";
import { isUuid, sql, type TenantTx, uuidv7 } from "@opendash/db";
import { audit } from "../audit/write";
import { BUDGETS } from "../budgets";
import { callTool, checkToolArguments } from "../mcp/executor";
import { loadServer, type McpDeps, McpProblem, resolveConnection } from "../mcp/shared";
import type { Viewer } from "../runs/ledger";
import { ownerOf } from "./data";
import { pinKey, serviceChanged, serviceNow } from "./service";
import { ACTIONS_OFF, actionsOff, DashboardProblem, definitionAt } from "./store";

/** Actions one person may prepare in ten minutes. */
const PER_TEN_MINUTES = 20;
/** How long a claimed change may take to be sent. */
const ACTION_MS = 60_000;
/** Said when a change's answer never came. */
const UNANSWERED =
  "The service didn't answer, so OpenDash can't tell whether it changed: check there before trying again.";
/** What's kept of a service's answer: its first words, as plain text. */
const MAX_RESULT = 300;

export interface PreparedAction {
  ticket: string;
  label: string;
  /** The dialog's question: the action's own, its key filled in, or what it does in words. */
  question: string;
  server: string;
  tool: string;
  /** Exactly what will be sent. */
  arguments: Record<string, unknown>;
  /** Whose account: the person's own, as the service knows it ("ana@acme.example"), when it said. */
  account: string | null;
  expiresAt: string;
}

export type ActionOutcome =
  | { status: "done" | "failed" | "unknown"; result: string; again: boolean }
  | { status: "running" };

const stableJson = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(stableJson).join(",")}]`
    : v && typeof v === "object"
      ? `{${Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`)
          .join(",")}}`
      : JSON.stringify(v ?? null);

/** Plain words from an answer: its text parts, control characters gone, cut. */
function plainResult(result: unknown): string {
  const content = (result as { content?: { type?: string; text?: string }[] } | null)?.content ?? [];
  const text = content
    .filter((c) => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join(" ");
  return [...text]
    .map((c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? " " : c))
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_RESULT);
}

/** Prepares a row's action for this person to confirm: the effect, written, and what the dialog shows. */
export async function prepareAction(
  tx: TenantTx,
  viewer: Viewer & { userId: string },
  input: { dashboardId: string; revision: string; section: string; action: string; key: unknown; snapshot?: string },
): Promise<PreparedAction> {
  const at = await definitionAt(tx, viewer, input.dashboardId, input.revision);
  if (!at) throw new DashboardProblem("not_found", "That dashboard isn't one you can read.");
  // A draft someone else saved last runs their code with this person's account: it changes nothing in a service.
  if (actionsOff(at, viewer)) throw new DashboardProblem("invalid", ACTIONS_OFF);
  // An App's query declares its actions: the grid on it names the query (its id in place of a section's).
  const q = Object.hasOwn(at.definition.queries, input.section) ? at.definition.queries[input.section] : undefined;
  const action = q?.actions?.find((a) => a.id === input.action);
  if (!action) throw new DashboardProblem("not_found", "That action isn't on this list.");
  const key = actionKey(input.key);
  if (key === null) throw new DashboardProblem("invalid", "That isn't one of its rows.");

  const [recent] = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from app.dashboard_action
    where org_id = ${viewer.orgId} and user_id = ${viewer.userId} and created_at > now() - interval '10 minutes'`);
  if ((recent?.n ?? 0) >= PER_TEN_MINUTES) {
    throw new DashboardProblem("invalid", "That's a lot of changes at once: wait a few minutes and try again.");
  }

  // A row read from a service: the key must be one the page shows, in the read it shows.
  const own =
    q && Object.hasOwn(at.definition.datasets ?? {}, q.source.dataset)
      ? at.definition.datasets?.[q.source.dataset]
      : undefined;
  if (q && own && isServiceDataset(own) && own.connection === q.source.connection) {
    const people = { owner: await ownerOf(tx, viewer.orgId, input.dashboardId), asker: viewer.userId };
    const now = await serviceNow(tx, viewer.orgId, own, people);
    if (!now.ok) throw new DashboardProblem("invalid", now.refused);
    if (!input.snapshot || !isUuid(input.snapshot)) throw new DashboardProblem("invalid", "Refresh the list first.");
    const [kept] = await tx.execute<{ has: boolean }>(sql`
      select exists (
        select 1 from app.dashboard_result r, jsonb_array_elements(r.result->'rows') as row
        where r.org_id = ${viewer.orgId} and r.cache_key = ${pinKey(now.identity, input.snapshot)}
          and r.status = 'ok' and r.expires_at > now() and row->>${own.key ?? ""} = ${String(key)}) as has`);
    if (!own.key || !kept?.has) {
      throw new DashboardProblem("invalid", "That row isn't in the list as it was read: refresh it and try again.");
    }
  }

  const server = await loadServer(tx, viewer.orgId, action.connection);
  if (server?.status !== "active") throw new DashboardProblem("invalid", "That service is turned off or gone.");
  if (!server.dashboards_allowed) {
    throw new DashboardProblem("invalid", `${server.name} isn't allowed in dashboards: an admin turns it on.`);
  }
  if (server.access !== "personal" || server.auth === "none") {
    throw new DashboardProblem(
      "invalid",
      `Changes in ${server.name} are made by a person with their own account, and ${server.name} is connected once for the workspace.`,
    );
  }
  const [tool] = await tx.execute<{
    name: string;
    digest: string;
    status: string;
    tier: string;
    dashboards_allowed: boolean;
    read_only: boolean;
    input_schema: Record<string, unknown>;
    annotations: Record<string, unknown>;
  }>(sql`
    select name, digest, status, tier, dashboards_allowed, input_schema, annotations,
      coalesce((annotations->>'readOnlyHint')::boolean, false) as read_only
    from app.mcp_tool where org_id = ${viewer.orgId} and server_id = ${server.id} and name = ${action.tool}`);
  if (tool?.status !== "active" || tool.tier === "blocked" || !tool.dashboards_allowed) {
    throw new DashboardProblem(
      "invalid",
      `${server.name}'s ${action.tool} isn't allowed in dashboards now: an admin turns it on under Data → Connections.`,
    );
  }
  if (tool.read_only) throw new DashboardProblem("invalid", `${action.tool} only reads: it isn't a change.`);

  const found = await resolveConnection(tx, { orgId: viewer.orgId, userId: viewer.userId }, server);
  if (found.kind !== "found" || found.scope !== "personal") {
    throw new DashboardProblem("invalid", `Connect your ${server.name} account under Data → Connections first.`);
  }
  if (found.connection.status !== "ready") {
    throw new DashboardProblem("invalid", `Reconnect your ${server.name} account under Data → Connections first.`);
  }

  const args = fillAction(action.arguments, key);
  try {
    checkToolArguments(tool, args);
  } catch (error) {
    if (error instanceof McpProblem) throw new DashboardProblem("invalid", error.message);
    throw error;
  }
  const ticket = uuidv7();
  const [row] = await tx.execute<{ expires_at: string }>(sql`
    insert into app.dashboard_action (org_id, id, dashboard_id, revision, section, action, user_id, record_key,
      server_id, tool, arguments, arguments_hash, connection_id, account_revision, tool_digest, expires_at)
    values (${viewer.orgId}, ${ticket}, ${input.dashboardId}, ${input.revision}, ${input.section}, ${action.id},
      ${viewer.userId}, ${String(key)}, ${server.id}, ${tool.name}, ${JSON.stringify(args)}::jsonb,
      ${createHash("sha256").update(stableJson(args)).digest("hex")}, ${found.connection.id},
      ${found.connection.revision}, ${tool.digest}, now() + interval '2 minutes')
    returning expires_at::text as expires_at`);
  const question = action.confirm
    ? action.confirm.replace(/\{key\}/g, String(key))
    : `${action.label}: ${String(key)}?`;
  return {
    ticket,
    label: action.label,
    question,
    server: server.name,
    tool: tool.name,
    arguments: args,
    account: found.connection.account,
    expiresAt: new Date(row?.expires_at ?? Date.now()).toISOString(),
  };
}

type EffectRow = {
  id: string;
  dashboard_id: string;
  server_id: string;
  tool: string;
  arguments: Record<string, unknown>;
  connection_id: string;
  account_revision: number;
  tool_digest: string;
  status: "prepared" | "running" | "done" | "failed" | "unknown";
  result: string | null;
  expired: boolean;
};

/** Runs a prepared action once, as the person who prepared it; a ticket run again says how it settled. */
export async function runAction(
  deps: McpDeps,
  viewer: Viewer & { userId: string },
  ticket: string,
): Promise<ActionOutcome> {
  if (!isUuid(ticket)) throw new DashboardProblem("not_found", "That change isn't one you prepared.");
  const who = { orgId: viewer.orgId, userId: viewer.userId };
  // A change still running long after any call could (its process stopped): settled unknown, never sent again.
  await deps.withTenant(who, (tx) =>
    tx.execute(sql`
      update app.dashboard_action set status = 'unknown', settled_at = now(), result = ${UNANSWERED}
      where org_id = ${viewer.orgId} and status = 'running' and ran_at < now() - interval '5 minutes'`),
  );
  const claimed = await deps
    .withTenant(who, async (tx) => {
      // Access is checked again before anything is sent: a share removed, or the dashboard made private, since it was
      // prepared, and the change isn't made (the revision it was prepared on, as the person may read it now).
      const [ticketOf] = await tx.execute<{ dashboard_id: string; revision: string }>(sql`
        select dashboard_id, revision from app.dashboard_action
        where org_id = ${viewer.orgId} and id = ${ticket} and user_id = ${viewer.userId} and status = 'prepared'`);
      const at = ticketOf ? await definitionAt(tx, viewer, ticketOf.dashboard_id, ticketOf.revision) : null;
      if (ticketOf && !at) {
        throw new DashboardProblem("not_found", "That dashboard isn't one you can read any more.");
      }
      if (at && actionsOff(at, viewer)) throw new DashboardProblem("invalid", ACTIONS_OFF);
      const [row] = await tx.execute<EffectRow>(sql`
      update app.dashboard_action set status = 'running', ran_at = now()
      where org_id = ${viewer.orgId} and id = ${ticket} and user_id = ${viewer.userId} and status = 'prepared'
        and expires_at > now()
      returning id, dashboard_id, server_id, tool, arguments, connection_id, account_revision, tool_digest, status,
        result, false as expired`);
      if (row) return { claimed: row };
      const [had] = await tx.execute<EffectRow>(sql`
      select id, dashboard_id, server_id, tool, arguments, connection_id, account_revision, tool_digest, status, result,
        expires_at <= now() as expired
      from app.dashboard_action where org_id = ${viewer.orgId} and id = ${ticket} and user_id = ${viewer.userId}`);
      return { had: had ?? null };
    })
    .catch((error: unknown) => {
      // Another change to this row is running (one at a time per row): nothing is sent.
      const e = error as { code?: string; cause?: { code?: string } } | null;
      if (e?.code === "23505" || e?.cause?.code === "23505") {
        throw new DashboardProblem("invalid", "Another change to this row is running: wait for it, then look again.");
      }
      throw error;
    });
  if ("had" in claimed) {
    const had = claimed.had;
    if (!had) throw new DashboardProblem("not_found", "That change isn't one you prepared.");
    if (had.status === "running") return { status: "running" };
    if (had.status === "prepared") {
      throw new DashboardProblem("invalid", "That was a while ago: press the action again to see what it will send.");
    }
    return { status: had.status, result: had.result ?? "", again: true };
  }
  const row = claimed.claimed;

  let status: "done" | "failed" | "unknown";
  let result: string;
  try {
    const outcome = await callTool(deps, who, {
      serverId: row.server_id,
      tool: row.tool,
      arguments: row.arguments,
      via: "dashboard",
      consented: true,
      once: true,
      // Never sent past a minute from its claim (the sweep above settles it at five).
      deadline: Date.now() + ACTION_MS,
      signal: AbortSignal.timeout(ACTION_MS + BUDGETS.mcp.callMs),
      policy: {
        readsOnly: false,
        ownAccount: true,
        expect: { connectionId: row.connection_id, accountRevision: row.account_revision, digest: row.tool_digest },
      },
    });
    if (outcome.state === "ready") {
      const said = plainResult(outcome.result);
      if ((outcome.result as { isError?: boolean }).isError) {
        status = "failed";
        result = said || `${outcome.server.name} refused it.`;
      } else {
        status = "done";
        result = said || "Done.";
      }
    } else {
      // Refused before anything was sent: the person's account, the tool or the server isn't ready.
      status = "failed";
      result =
        outcome.state === "blocked"
          ? outcome.message
          : outcome.state === "rate_limited"
            ? `${outcome.server.name} is busy: nothing was sent. Try again in a minute.`
            : outcome.state === "consent"
              ? `${outcome.server.name}'s ${outcome.tool} changed since an admin reviewed it: nothing was sent.`
              : `Reconnect your ${outcome.server.name} account under Data → Connections: nothing was sent.`;
    }
  } catch (error) {
    // Sent, maybe: the answer never came. Never sent again.
    status = error instanceof McpProblem ? "failed" : "unknown";
    result = error instanceof McpProblem ? error.message : UNANSWERED;
  }
  result = result.slice(0, MAX_RESULT);
  await deps.withTenant(who, async (tx) => {
    await tx.execute(sql`
      update app.dashboard_action set status = ${status}, result = ${result}, settled_at = now()
      where org_id = ${viewer.orgId} and id = ${row.id} and status = 'running'`);
    await audit(tx, {
      action: "mcp_tool.called",
      target: { type: "mcp_server", id: row.server_id },
      detail: { tool: row.tool.slice(0, 64), via: "dashboard", outcome: status },
    });
    // The service changed: every page reads it again.
    if (status === "done") await serviceChanged(tx, viewer.orgId);
  });
  return { status, result, again: false };
}

/**
 * A change a run asks a service to make, through the effect outbox (AGENTS.md: external side effects): one row per
 * operation, its identity the run, the server, the tool and its arguments (callDigest), written `sending` before the
 * call goes. A second call of the same operation in the run, from any tool call (a model that calls again after a
 * crash or a timeout gets a fresh call id), finds the row and isn't sent: what's `sending` or `unknown` may have been
 * made, and a change is never made twice. Only an outcome that says nothing went (`failed`) frees it for another try.
 *
 * The row lives apart from the call's ledger row, so settling that call (a stop, a timeout, a restart) can't erase it.
 * Nothing delivers these rows: the call itself is the send, and the row is its record.
 */
import { isUuid, sql, type TenantTx, uuidv7 } from "@opendash/db";
import { callDigest } from "./cards";

export interface SendOperation {
  orgId: string;
  runId: string;
  /** The ledger row of the call that sends it (for the record; the operation is the same whichever call it is). */
  toolCallId: string | null;
  serverId: string;
  tool: string;
  args: Record<string, unknown>;
}

/** How an earlier send of the same operation stands: being sent or unknown (it may have been made), or made. */
export type SendRefused = "sending" | "unknown" | "sent";

const keyOf = (op: SendOperation) => `mcp_call:${op.runId}:${callDigest(op.serverId, op.tool, op.args)}`;

/**
 * Claims the operation for one send: its outbox row, `sending`, written now (commit it before the call goes). Refused
 * with how the earlier one stands when the run already sent it or is sending it; a send that failed before anything
 * went is claimed again.
 */
export async function claimSend(tx: TenantTx, op: SendOperation): Promise<{ id: string } | { refused: SendRefused }> {
  const key = keyOf(op);
  const source = op.toolCallId && isUuid(op.toolCallId) ? op.toolCallId : null;
  const [claimed] = await tx.execute<{ id: string }>(sql`
    insert into app.effect (org_id, id, purpose, source_type, source_id, channel, recipient_key, payload,
      idempotency_key, status, attempt)
    values (${op.orgId}, ${uuidv7()}, 'action', 'tool_call', ${source}, 'mcp', ${`mcp:${op.serverId}`},
      ${JSON.stringify({ runId: op.runId, serverId: op.serverId, tool: op.tool.slice(0, 200) })}::jsonb, ${key},
      'sending', 1)
    on conflict (org_id, idempotency_key) do update set status = 'sending', attempt = app.effect.attempt + 1,
      source_id = excluded.source_id, receipt = '{}'::jsonb, updated_at = now()
      where app.effect.status = 'failed'
    returning id`);
  if (claimed) return { id: claimed.id };
  const [had] = await tx.execute<{ status: string }>(sql`
    select status from app.effect where org_id = ${op.orgId} and idempotency_key = ${key}`);
  return { refused: had?.status === "sent" ? "sent" : had?.status === "unknown" ? "unknown" : "sending" };
}

/**
 * How a claimed send settled: `sent` (the service answered), `failed` (nothing went: refused before it was sent, or
 * the service said it failed), `unknown` (no answer: it may have been made). Only a row still `sending` is settled.
 */
export async function settleSend(
  tx: TenantTx,
  orgId: string,
  id: string,
  status: "sent" | "failed" | "unknown",
  why: string,
): Promise<void> {
  await tx.execute(sql`
    update app.effect set status = ${status}, receipt = ${JSON.stringify({ why: why.slice(0, 64) })}::jsonb,
      sent_at = ${status === "sent" ? sql`now()` : sql`sent_at`}, updated_at = now()
    where org_id = ${orgId} and id = ${id} and status = 'sending'`);
}

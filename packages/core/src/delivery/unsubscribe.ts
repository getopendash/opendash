/**
 * One-click unsubscribe: every email a routine sends carries a link, and the List-Unsubscribe
 * headers, holding a signed token: who, in which workspace, and which routine to take them off. The token can only do
 * that; it's signed with a key derived from the auth secret, so the web app and the worker share it without storing
 * anything. Links don't expire: rotating the auth secret retires them all (the usual trade-off for one-click
 * unsubscribe; the routine's page always works).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { isUuid, sql, type TenantTx } from "@opendash/db";
import { sentenceText } from "../routines/sentence";
import { listRoutines, reconcileChecks } from "../routines/store";

export interface UnsubscribeTarget {
  orgId: string;
  userId: string;
  routineId: string;
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");
// v2: routines' links (v1 named the digest, the weekly review and dashboard subscriptions, all gone).
const keyOf = (secret: string) => createHmac("sha256", secret).update("opendash/unsubscribe/v2").digest();
const sign = (secret: string, body: string) => createHmac("sha256", keyOf(secret)).update(body).digest();

export function unsubscribeToken(secret: string, t: UnsubscribeTarget): string {
  const body = b64(JSON.stringify([t.orgId, t.userId, t.routineId]));
  return `${body}.${b64(sign(secret, body))}`;
}

/** The target a token names, or null for one that's malformed or wasn't signed with this secret. */
export function readUnsubscribeToken(secret: string, token: string): UnsubscribeTarget | null {
  const [body, mac, extra] = token.split(".");
  if (!body || !mac || extra !== undefined || body.length > 400) return null;
  const want = sign(secret, body);
  const got = Buffer.from(mac, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 3) return null;
    const [orgId, userId, routineId] = parsed as unknown[];
    if (![orgId, userId, routineId].every((x) => typeof x === "string" && isUuid(x))) return null;
    return { orgId: orgId as string, userId: userId as string, routineId: routineId as string };
  } catch {
    return null;
  }
}

/**
 * What the confirmation page says: the workspace, and the routine they'd leave. Names only to a member: someone
 * who has left keeps their old emails, and their links stop naming the workspace or its routines.
 */
export async function describeUnsubscribe(
  tx: TenantTx,
  t: UnsubscribeTarget,
): Promise<{ organization: string; what: string; on: boolean }> {
  const [member] = await tx.execute(sql`select 1 from app.member_recipient(${t.userId})`);
  if (!member) return { organization: "your workspace", what: "a routine's emails", on: false };
  const [o] = await tx.execute<{ name: string }>(sql`select name from app.org where id = ${t.orgId}`);
  const [r] = await listRoutines(tx, { orgId: t.orgId, userId: t.userId, canManage: false }, { id: t.routineId });
  const on = Boolean(r?.userIds.includes(t.userId));
  return {
    organization: o?.name ?? "Your workspace",
    // The link works without signing in: once they've left, it no longer says what the routine does now.
    what: r && on ? `the emails of the routine “${sentenceText(r.sentence)}”` : "a routine's emails",
    on,
  };
}

/**
 * Takes the person off the routine. True when they were on it. A routine left reaching nobody pauses, saying so.
 */
export async function applyUnsubscribe(tx: TenantTx, t: UnsubscribeTarget): Promise<boolean> {
  const rows = await tx.execute(sql`
    update app.routine set user_ids = array_remove(user_ids, ${t.userId}::uuid), updated_at = now()
    where org_id = ${t.orgId} and id = ${t.routineId} and ${t.userId}::uuid = any(user_ids) returning id`);
  if (!rows.length) return false;
  const paused = await tx.execute(sql`
    update app.routine set status = 'paused', paused_reason = 'Nobody gets it any more.', updated_at = now()
    where org_id = ${t.orgId} and id = ${t.routineId} and status = 'active' and key is null
      and cardinality(user_ids) = 0 and jsonb_array_length(slack) = 0 returning id`);
  if (paused.length) await reconcileChecks(tx, t.orgId);
  return true;
}

import { sql } from "drizzle-orm";
import { type Database, getAppDatabase, getSystemDatabase } from "./client";
import { isUuid } from "./ids";

export interface TenantCtx {
  orgId: string;
  userId?: string | null;
}

declare const tenantBrand: unique symbol;
declare const systemBrand: unique symbol;
declare const publicBrand: unique symbol;
type Transaction = Parameters<Parameters<Database["db"]["transaction"]>[0]>[0];

/** A transaction with tenant context set. Repositories accept only this type, never a raw handle. */
export type TenantTx = Transaction & { readonly [tenantBrand]: true };
/** A transaction as opendash_system (dispatcher, maintenance). Access comes from explicit `system` policies. */
export type SystemTx = Transaction & { readonly [systemBrand]: true };
/**
 * A transaction as opendash_app with no tenant: row-level security shows it nothing, so only a
 * SECURITY DEFINER function written for it answers (`app.resolve_share`).
 */
export type PublicTx = Transaction & { readonly [publicBrand]: true };

export class TenantContextError extends Error {
  override name = "TenantContextError";
}

/**
 * Runs fn in one short transaction whose first statement sets the tenant context with set_config(…, true).
 * Transaction-local, so it works through transaction-mode poolers. Never hold it open across an LLM call or a
 * warehouse query.
 */
export function withTenantOn<T>(database: Database, ctx: TenantCtx, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  if (!isUuid(ctx.orgId)) throw new TenantContextError("orgId must be a uuid");
  if (ctx.userId != null && !isUuid(ctx.userId)) throw new TenantContextError("userId must be a uuid");
  return database.db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.org_id', ${ctx.orgId}, true), set_config('app.user_id', ${ctx.userId ?? ""}, true)`,
    );
    return fn(tx as TenantTx);
  });
}

export function withSystemOn<T>(database: Database, fn: (tx: SystemTx) => Promise<T>): Promise<T> {
  return database.db.transaction(async (tx) => fn(tx as SystemTx));
}

export function withPublicOn<T>(database: Database, fn: (tx: PublicTx) => Promise<T>): Promise<T> {
  return database.db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.org_id', '', true), set_config('app.user_id', '', true)`);
    return fn(tx as PublicTx);
  });
}

export const withPublic = <T>(fn: (tx: PublicTx) => Promise<T>): Promise<T> => withPublicOn(getAppDatabase(), fn);

export const withTenant = <T>(ctx: TenantCtx, fn: (tx: TenantTx) => Promise<T>): Promise<T> =>
  withTenantOn(getAppDatabase(), ctx, fn);

export const withSystem = <T>(fn: (tx: SystemTx) => Promise<T>): Promise<T> => withSystemOn(getSystemDatabase(), fn);

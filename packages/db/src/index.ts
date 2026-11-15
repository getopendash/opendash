// Public surface of @opendash/db. The raw client is internal; every query goes through withTenant or withSystem.

// The one drizzle instance: packages that depend on @opendash/db build SQL with this, never their own drizzle-orm copy.
export { type SQL, sql } from "drizzle-orm";
export { chatStatePool } from "./chat-state";
export { closeDatabases } from "./client";
export { checkExtensions, lastTick, REQUIRED_EXTENSIONS } from "./health";
export { isUuid, uuidv7, uuidv7Floor } from "./ids";
export { createListener, directListener, type Listener } from "./listen";
export * as schema from "./schema";
export {
  type PublicTx,
  type SystemTx,
  TenantContextError,
  type TenantCtx,
  type TenantTx,
  withPublic,
  withSystem,
  withTenant,
} from "./tenant";

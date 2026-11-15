// @opendash/db/auth: the Better Auth tables and the opendash_auth connection, for packages/auth only.
// opendash_auth can reach nothing outside the auth schema, so this handle can't bypass tenancy.
export { type Database as AuthDatabase, getAuthDatabase } from "./client";
export * as authTables from "./schema/auth";

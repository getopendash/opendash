import { pgRole } from "drizzle-orm/pg-core";

/** Roles are created by scripts/bootstrap.ts (they're cluster-wide); drizzle-kit only references them. */
export const appRole = pgRole("opendash_app").existing();
export const systemRole = pgRole("opendash_system").existing();

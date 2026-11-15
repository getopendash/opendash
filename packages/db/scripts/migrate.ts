import path from "node:path";
import { loadRootEnv } from "../../../scripts/load-env.mjs";
import { runMigrations } from "../src/migrate";

// Same settings as the web app: the real environment, then .env.local, then .env (blanks never win).
loadRootEnv(path.resolve(import.meta.dirname, "../../.."));

const url = process.env.DATABASE_OWNER_URL;
if (!url) throw new Error("Set DATABASE_OWNER_URL (opendash_owner, direct connection) to run migrations.");
await runMigrations(url);
console.info("migrations applied");

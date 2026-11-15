import path from "node:path";
import { loadRootEnv } from "../../../scripts/load-env.mjs";
import { bootstrap } from "../src/bootstrap";

// Same settings as the web app: the real environment, then .env.local, then .env (blanks never win).
loadRootEnv(path.resolve(import.meta.dirname, "../../.."));

const url = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_OWNER_URL;
if (!url) throw new Error("Set DATABASE_ADMIN_URL (an admin or the owner role) to bootstrap the database.");
await bootstrap(url, {
  passwords: {
    opendash_owner: process.env.OPENDASH_DB_OWNER_PASSWORD,
    opendash_app: process.env.OPENDASH_DB_APP_PASSWORD,
    opendash_system: process.env.OPENDASH_DB_SYSTEM_PASSWORD,
    opendash_auth: process.env.OPENDASH_DB_AUTH_PASSWORD,
    opendash_queue: process.env.OPENDASH_DB_QUEUE_PASSWORD,
  },
});
console.info("bootstrap done: roles, schemas, extensions, default privileges");

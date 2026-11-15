// Used only by the schema generator (`pnpm --filter @opendash/auth generate:schema`). It needs the same plugins as
// the runtime config but no database connection.
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { schemaPlugins } from "./plugins";

export const auth = betterAuth({
  database: drizzleAdapter({} as never, { provider: "pg", schemaName: "auth" }),
  telemetry: { enabled: false },
  emailAndPassword: { enabled: true },
  plugins: [...schemaPlugins()],
});

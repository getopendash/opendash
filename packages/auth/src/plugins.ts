import { apiKey } from "@better-auth/api-key";
import { organization } from "better-auth/plugins";
import { API_KEY_TTL_SECONDS } from "./keys";
import { organizationAccessControl, organizationRoles } from "./permissions";
import { twoFactorPlugin } from "./two-factor";

/** How long an invitation can be accepted: the members page and the email say so. */
export const INVITATION_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Plugins that shape the auth schema. Shared by the runtime config (auth.ts) and the schema generator
 * (auth-config.ts), so `pnpm --filter @opendash/auth generate:schema` always matches what runs.
 */
export function schemaPlugins(runtime: OrganizationRuntime = {}) {
  return [
    organization({
      ac: organizationAccessControl,
      roles: organizationRoles,
      teams: { enabled: true },
      requireEmailVerificationOnInvitation: true,
      // A week to accept (Better Auth's default is 48 hours); resending starts a new week.
      invitationExpiresIn: INVITATION_TTL_SECONDS,
      // Deleting a workspace isn't built: it has to take its data, keys, Slack and queued work with it, at once.
      // Better Auth's own delete removed every member and then failed on app.org, leaving its keys working.
      disableOrganizationDeletion: true,
      ...runtime,
    }),
    // Two key types (entry paths):
    //  - org-owned keys act as the organization;
    //  - user-owned keys act as the user and need X-Org-Id plus a membership check.
    // Both expire after 90 days, a life nobody can change (making a key, or updating it to never expire), and are
    // revoked as keys.ts says.
    apiKey([
      {
        configId: "org",
        references: "organization",
        defaultPrefix: "odo_",
        keyExpiration: { defaultExpiresIn: API_KEY_TTL_SECONDS, disableCustomExpiresTime: true },
      },
      {
        configId: "user",
        references: "user",
        defaultPrefix: "odu_",
        keyExpiration: { defaultExpiresIn: API_KEY_TTL_SECONDS, disableCustomExpiresTime: true },
      },
    ]),
    // An authenticator app and backup codes, asked for after the password or an email link (two-factor.ts).
    twoFactorPlugin(),
  ] as const;
}

type OrganizationOptions = NonNullable<Parameters<typeof organization>[0]>;

/** Runtime-only organization options; none of them change the schema. */
export type OrganizationRuntime = Pick<
  OrganizationOptions,
  "organizationHooks" | "allowUserToCreateOrganization" | "sendInvitationEmail"
>;

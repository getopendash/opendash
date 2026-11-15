// The handle the auth functions read with: app code passes it on and never reads the auth schema itself.
export { type AuthDatabase, getAuthDatabase } from "@opendash/db/auth";
export type { AuthAudit } from "./audit";
export {
  type Auth,
  type CreateAuthOptions,
  createAuth,
  inviteOnlyFromEnv,
} from "./auth";
export {
  type AccountDeletion,
  type AccountDeletionPlan,
  type AccountExport,
  type AccountWorkspace,
  accountDeletionPlan,
  accountExport,
  confirmPassword,
  deleteAccount,
  deleteOrganization,
} from "./deletion";
export {
  type AuthCore,
  type AuthExtension,
  type AuthExtensionSource,
  combineExtensions,
  SESSION_PROVENANCE_FIELDS,
} from "./extension";
export { API_KEY_TTL_SECONDS, isOwnerRole, recordKeyMaker, revokeOrgKeys, revokeUserKeys } from "./keys";
export { type AuthMail, consoleMailer, defaultMailer, emailMailer, type Mailer, memoryMailer } from "./mailer";
export { assertProductionTrustedOrigins, authBaseUrl, resolveTrustedOrigins } from "./origins";
export { organizationAccessControl, organizationRoles } from "./permissions";
export { resetPasswordEmail } from "./previews";
export { provisionMissingOrgs, provisionOrg } from "./provision";
export { authRoutes, EMAIL_LINK_TTL_SECONDS, magicLinkVerifyPath, safeRedirectPath } from "./routes";
export {
  anyAccount,
  type InvitationPreview,
  invitationPreview,
  memberCount,
  memberNames,
  memberships,
  type OrgPerson,
  orgPeople,
  resolveTenant,
  resolveViewer,
  TenantAccessDenied,
  type TenantPrincipal,
  type Viewer,
  type ViewerUser,
} from "./tenant-context";

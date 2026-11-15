import type { AccessControl } from "better-auth/plugins/access";
import { adminAc, defaultAc, memberAc, ownerAc } from "better-auth/plugins/organization/access";

// Better Auth controls organization and membership
// management; OpenDash resource permissions (project Viewer / Editor / Manager) live in packages/core.
// Viewer gets the same read-only organization access as member.
export const viewerAc = defaultAc.newRole({
  organization: [],
  member: [],
  invitation: [],
  team: [],
  ac: ["read"],
});

// The public OrganizationOptions type widens AccessControl's generic statements; the runtime object is the
// canonical default controller exported by the plugin.
export const organizationAccessControl = defaultAc as unknown as AccessControl;
export const organizationRoles = {
  owner: ownerAc,
  admin: adminAc,
  member: memberAc,
  viewer: viewerAc,
};

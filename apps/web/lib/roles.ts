/** Roles and what each may do: shared by the members page (server) and its client components. */
export type Role = "owner" | "admin" | "member" | "viewer";
export const ROLES: Role[] = ["owner", "admin", "member", "viewer"];

export const ROLE_INFO: Record<Role, { label: string; description: string }> = {
  owner: { label: "Owner", description: "Everything an admin does, and makes other owners." },
  admin: { label: "Admin", description: "Manages members and sources, approves definitions, reviews feedback." },
  member: { label: "Member", description: "Asks questions and shares conversations." },
  viewer: { label: "Viewer", description: "Reads the conversations shared with them." },
};

export interface Member {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: Role;
  joinedAt: string;
}

export interface Invitation {
  id: string;
  email: string;
  role: Role;
  expiresAt: string;
  expired: boolean;
  inviterId: string;
  inviter: string | null;
}

/** Owners and admins invite people, change roles and remove members (Better Auth enforces the same, and more). */
export const canManageTeam = (role: string) => role === "owner" || role === "admin";

/** Viewers read what's shared with them; everyone else asks (the API refuses a viewer's question too). */
export const canAsk = (role: string) => role !== "viewer";

/** The roles someone may hand out: only an owner makes owners. */
export const assignable = (actor: string): Role[] => ROLES.filter((r) => r !== "owner" || actor === "owner");

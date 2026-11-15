import "server-only";
import type { EnterpriseSso, SsoCaller } from "@opendash/core/enterprise";
import { headers } from "next/headers";
import { enterprise } from "@/enterprise";
import { getAuth, requireTenant } from "@/lib/auth";

/** The signed-in person as single sign-on's manager sees them: their workspace, role and this very session. */
export async function ssoCaller(): Promise<{
  sso: EnterpriseSso;
  caller: SsoCaller;
  session: SessionProvenance;
} | null> {
  const sso = enterprise().sso;
  if (!sso) return null;
  const viewer = await requireTenant();
  const requestHeaders = await headers();
  const current = await getAuth().api.getSession({ headers: requestHeaders });
  if (!current) return null;
  const s = current.session as typeof current.session & {
    ssoProviderId?: string | null;
    authenticatedAt?: Date | string | null;
  };
  return {
    sso,
    caller: {
      orgId: viewer.ctx.orgId,
      userId: viewer.user.id,
      sessionId: s.id,
      role: viewer.role,
      headers: requestHeaders,
    },
    session: {
      providerId: s.ssoProviderId ?? null,
      at: s.authenticatedAt ? new Date(s.authenticatedAt).toISOString() : null,
    },
  };
}

/** Where this session came from: the provider whose test sign-in it can prove, and when. */
export interface SessionProvenance {
  providerId: string | null;
  at: string | null;
}

import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { Analytics } from "@/components/shell/analytics";
import { AppShell } from "@/components/shell/app-shell";
import { analyticsSetup } from "@/lib/analytics";
import { helpLinks } from "@/lib/help";
import { openInsightsFor } from "@/lib/insights";
import { sidebarProjects } from "@/lib/projects";
import { setupProgress } from "@/lib/setup";
import { SIDEBAR_COOKIE } from "@/lib/sidebar";
import { currentWorkspace } from "@/lib/workspace";

/** Everything behind sign-in. currentWorkspace sends anyone not in a workspace to their next step. */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const ws = await currentWorkspace();
  const { done, total, next } = setupProgress(ws);
  // Setting up is the owners' and admins' job; members and viewers don't get the card.
  const manages = ws.role === "owner" || ws.role === "admin";
  const attention = ws.sourceStates.filter(
    (s) => s.status === "failed" || s.status === "error" || s.status === "failing",
  );
  const learning = ws.sourceStates.find((s) => s.status === "learning" || s.status === "syncing");
  const rail = (await cookies()).get(SIDEBAR_COOKIE)?.value === "rail";
  const [projects, insights] = await Promise.all([
    sidebarProjects(ws.org.id, ws.user.id, ws.role),
    ws.sources > 0 ? openInsightsFor({ orgId: ws.org.id, userId: ws.user.id }) : 0,
  ]);
  const analytics = analyticsSetup(ws.user.id, ws.org.id);
  return (
    <>
      {analytics ? <Analytics setup={analytics} /> : null}
      <AppShell
        rail={rail}
        user={{ name: ws.user.name, email: ws.user.email }}
        help={helpLinks()}
        org={{ id: ws.org.id, name: ws.org.name }}
        orgs={ws.orgs}
        hasData={ws.sources > 0}
        canReview={ws.role === "owner" || ws.role === "admin"}
        viewer={ws.role === "viewer"}
        projects={projects}
        insights={insights}
        setup={{
          done,
          total,
          next:
            manages && next ? { key: next.key, label: next.next, href: next.href, inProgress: next.inProgress } : null,
        }}
        status={
          attention.length
            ? {
                tone: "danger",
                label: `${attention.length} ${attention.length === 1 ? "source needs" : "sources need"} attention`,
                href: attention.length === 1 ? `/data/sources/${attention[0]?.id}` : "/data/sources",
              }
            : learning
              ? {
                  tone: "accent",
                  label: `${learning.status === "learning" ? "Learning" : "Syncing"} ${learning.name}`,
                  href: `/data/sources/${learning.id}`,
                }
              : null
        }
      >
        {children}
      </AppShell>
    </>
  );
}

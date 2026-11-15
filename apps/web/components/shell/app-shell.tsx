"use client";

import { usePathname } from "next/navigation";
import { type ReactNode, useEffect } from "react";
import { AnalystPanel } from "@/components/panel/analyst-panel";
import { PanelProvider } from "@/components/panel/panel-context";
import { SearchPalette } from "@/components/search/search-palette";
import type { HelpLink } from "@/lib/help";
import type { AccountUser } from "./account-menu";
import type { OrgOption } from "./org-switcher";
import type { SetupCardData } from "./setup-card";
import { ShellProvider, useShell } from "./shell-context";
import { Sidebar, type SidebarProject } from "./sidebar";
import type { StatusPillData } from "./status-pill";

interface ShellProps {
  user: AccountUser;
  /** Where to get help on this instance (docs, support, status): what its operator set, in the account menu. */
  help: HelpLink[];
  org: OrgOption;
  orgs: OrgOption[];
  hasData: boolean;
  /** Owners and admins: they review feedback. */
  canReview: boolean;
  /** A viewer: reads what's shared, doesn't ask. */
  viewer: boolean;
  setup: SetupCardData;
  status: StatusPillData | null;
  /** The projects this person is in, for the sidebar's Projects section. */
  projects: SidebarProject[];
  /** Open insights, for the count beside Insights. */
  insights: number;
  /** The sidebar starts as a rail (its cookie, read by the layout). */
  rail?: boolean;
  children: ReactNode;
}

function Frame({
  user,
  help,
  org,
  orgs,
  hasData,
  canReview,
  viewer,
  setup,
  status,
  projects,
  insights,
  children,
}: ShellProps) {
  const { collapsed, animate, drawerOpen, closeDrawer } = useShell();
  const pathname = usePathname();
  // Following a link in the phone drawer closes it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the route changes
  useEffect(() => closeDrawer(), [pathname]);
  return (
    <div className="flex h-dvh bg-background lg:py-sheet-inset lg:pr-sheet-inset">
      <SearchPalette />
      {/* Desktop: the sidebar sits on the app background, borderless; collapsed, a rail of icons. Below lg it's a
          drawer over the sheet. */}
      <aside
        className="sidebar-frame hidden shrink-0 lg:block"
        data-rail={collapsed ? "" : undefined}
        data-animate={animate ? "" : undefined}
      >
        <Sidebar
          rail={collapsed}
          user={user}
          help={help}
          org={org}
          orgs={orgs}
          hasData={hasData}
          viewer={viewer}
          setup={setup}
          status={status}
          projects={projects}
          insights={insights}
        />
      </aside>
      {drawerOpen ? (
        <div className="fixed inset-0 z-50 flex lg:hidden">
          <div className="enter-drawer h-full bg-background shadow-overlay">
            <Sidebar
              user={user}
              help={help}
              org={org}
              orgs={orgs}
              hasData={hasData}
              viewer={viewer}
              setup={setup}
              status={status}
              projects={projects}
              insights={insights}
            />
          </div>
          <button
            type="button"
            aria-label="Close sidebar"
            className="enter-fade flex-1 bg-backdrop"
            onClick={closeDrawer}
          />
        </div>
      ) : null}
      {/* The page sheet is a container (@container/page): a page lays out by the room it has, which the analyst's
          panel beside it takes some of, never by the window's width. A page's own pane (Sources, a figure's trace)
          too wide to sit beside it covers the sheet (absolute), never the sidebar or the panel. */}
      <main className="@container/page relative flex min-w-0 flex-1 flex-col overflow-hidden bg-surface lg:rounded-sheet lg:border lg:border-border">
        {children}
      </main>
      {/* The analyst beside every page: a second sheet, kept as its person moves around. */}
      <AnalystPanel org={org.name} canAsk={!viewer} canVerify={canReview} />
    </div>
  );
}

/** The app layout from the G screens: quiet sidebar plus an inset, rounded content sheet. */
export function AppShell(props: ShellProps) {
  return (
    <ShellProvider rail={props.rail}>
      <PanelProvider scope={props.org.id}>
        <Frame {...props} />
      </PanelProvider>
    </ShellProvider>
  );
}

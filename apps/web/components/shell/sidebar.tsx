"use client";

import { Button, Tooltip } from "@heroui/react";
import { OpenDashLogo, OpenDashMark } from "@opendash/ui";
import {
  BookOpen,
  Database,
  FolderKanban,
  House,
  LayoutDashboard,
  ListChecks,
  type LucideIcon,
  MessageSquareText,
  PanelLeft,
  Radar,
  Repeat,
  Search,
  Settings,
  SquarePen,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, useEffect } from "react";
import { ProjectAvatar } from "@/components/projects/project-avatar";
import { OPEN_SEARCH } from "@/components/search/search-palette";
import type { HelpLink } from "@/lib/help";
import { AccountMenu, type AccountUser } from "./account-menu";
import { type OrgOption, OrgSwitcher } from "./org-switcher";
import { SetupCard, type SetupCardData } from "./setup-card";
import { useShell } from "./shell-context";
import { StatusPill, type StatusPillData } from "./status-pill";

interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  /** Only usable once the workspace has a connected source. */
  needsData?: boolean;
  /** Not built yet: shown so the shape of the product is visible, but not a dead link. */
  soon?: boolean;
}

const NAV: NavItem[] = [
  { label: "Home", href: "/", icon: House },
  { label: "Ask", href: "/ask", icon: MessageSquareText, needsData: true },
  { label: "Insights", href: "/insights", icon: Radar, needsData: true },
  { label: "Tasks", href: "/tasks", icon: ListChecks, needsData: true },
  { label: "Dashboards", href: "/dashboards", icon: LayoutDashboard, needsData: true },
  { label: "Routines", href: "/routines", icon: Repeat, needsData: true },
  { label: "Knowledge", href: "/knowledge", icon: BookOpen, needsData: true },
  { label: "Data", href: "/data/sources", icon: Database },
];

/** Settings, at the sidebar's foot: its pages are listed inside the sheet (SectionNav), as Knowledge's are. */
const SETTINGS: NavItem = { label: "Settings", href: "/settings/members", icon: Settings };

const NEEDS_DATA = "Connect a data source first";
const VIEWER = "Viewers read the conversations shared with them.";
const SOON = "Coming soon";

const isActive = (pathname: string, href: string) =>
  href === "/"
    ? pathname === "/"
    : pathname === href || pathname.startsWith(`${href.split("/").slice(0, 2).join("/")}/`);

function NavRow({
  item,
  active,
  reason,
  count = 0,
  rail = false,
}: {
  item: NavItem;
  active: boolean;
  reason: string | null;
  /** What's waiting there (Insights' open count), shown at the end of the row (a dot on the rail). */
  count?: number;
  /** The collapsed sidebar: the icon alone, its label a tooltip. */
  rail?: boolean;
}) {
  const Icon = item.icon;
  const base = rail
    ? "relative flex size-9 items-center justify-center rounded-xl"
    : "flex h-8 items-center gap-2.5 rounded-xl px-2 text-body";
  if (reason) {
    return (
      <Tooltip delay={300}>
        <Tooltip.Trigger>
          <span aria-disabled className={`${base} cursor-not-allowed text-muted-tertiary`}>
            <Icon className="size-4" aria-hidden />
            {rail ? <span className="sr-only">{item.label}</span> : item.label}
          </span>
        </Tooltip.Trigger>
        <Tooltip.Content placement="right">{rail ? `${item.label}: ${reason}` : reason}</Tooltip.Content>
      </Tooltip>
    );
  }
  const link = (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      aria-label={rail ? (count ? `${item.label}, ${count} open` : item.label) : undefined}
      className={`${base} text-foreground ${active ? "bg-default" : "hover:bg-default"}`}
    >
      <Icon className="size-4 text-muted" aria-hidden />
      {rail ? (
        count ? (
          <span className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-accent" aria-hidden />
        ) : null
      ) : (
        <>
          <span className="flex-1">{item.label}</span>
          {count ? (
            <span className="text-small text-muted-tertiary tabular-nums" role="status" aria-label={`${count} open`}>
              {count}
            </span>
          ) : null}
        </>
      )}
    </Link>
  );
  if (!rail) return link;
  return (
    <Tooltip delay={200}>
      <Tooltip.Trigger>{link}</Tooltip.Trigger>
      <Tooltip.Content placement="right">{item.label}</Tooltip.Content>
    </Tooltip>
  );
}

export interface SidebarProject {
  id: string;
  name: string;
}

/**
 * The quiet sidebar: the logo, the workspace under it, New question, the navigation and the
 * person's projects; at its foot, setting up, Settings, and you (your account, the theme, signing out).
 */
export function Sidebar({
  rail = false,
  user,
  help,
  org,
  orgs,
  hasData,
  viewer,
  setup,
  status,
  projects,
  insights = 0,
}: {
  /** Collapsed: a rail of icons (the logo's mark, the navigation, the workspace and you), labels as tooltips. */
  rail?: boolean;
  user: AccountUser;
  help: HelpLink[];
  org: OrgOption;
  orgs: OrgOption[];
  hasData: boolean;
  /** Viewers read what's shared with them; they don't ask. */
  viewer: boolean;
  setup: SetupCardData;
  status: StatusPillData | null;
  projects: SidebarProject[];
  /** Open insights: the count beside Insights. */
  insights?: number;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const { toggle } = useShell();
  const canAsk = hasData && !viewer;
  // N starts a new question from anywhere, unless someone is typing.
  useEffect(() => {
    if (!canAsk) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = el?.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el?.tagName ?? "");
      // Chrome's autofill sends keydown events without a key.
      if (e.key?.toLowerCase() === "n" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && !typing) {
        e.preventDefault();
        router.push("/ask/new");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canAsk, router]);
  if (rail) {
    const tip = (label: string, node: ReactNode) => (
      <Tooltip delay={200}>
        <Tooltip.Trigger>{node}</Tooltip.Trigger>
        <Tooltip.Content placement="right">{label}</Tooltip.Content>
      </Tooltip>
    );
    return (
      <nav aria-label="Main" className="flex h-full w-14 flex-col items-center gap-0.5 py-1">
        <Link href="/" aria-label="OpenDash, home" className="flex size-10 items-center justify-center">
          <OpenDashMark className="size-6 text-brand" />
        </Link>
        {tip(
          "Show sidebar",
          <Button isIconOnly size="lg" variant="ghost" aria-label="Show sidebar" onPress={toggle}>
            <PanelLeft className="text-muted" />
          </Button>,
        )}
        {tip(
          "Search (⌘K)",
          <Button
            isIconOnly
            size="lg"
            variant="ghost"
            aria-label="Search (⌘K)"
            onPress={() => window.dispatchEvent(new Event(OPEN_SEARCH))}
          >
            <Search className="text-muted" />
          </Button>,
        )}
        <OrgSwitcher active={org} orgs={orgs} compact />
        <div className="h-1.5" />
        {canAsk
          ? tip(
              "New question (N)",
              <Link
                href="/ask/new"
                aria-label="New question"
                className="flex size-9 items-center justify-center rounded-xl border border-border bg-surface hover:bg-default"
              >
                <SquarePen className="size-4" aria-hidden />
              </Link>,
            )
          : null}
        <div className="h-1.5" />
        <div className="flex min-h-0 flex-1 flex-col items-center gap-0.5 overflow-y-auto">
          {NAV.map((item) => (
            <NavRow
              key={item.href}
              rail
              item={item}
              active={isActive(pathname, item.href)}
              reason={item.needsData && !hasData ? NEEDS_DATA : item.soon ? SOON : null}
              count={item.href === "/insights" ? insights : 0}
            />
          ))}
          <div className="h-2" />
          <NavRow
            rail
            item={{ label: "Projects", href: "/projects", icon: FolderKanban }}
            active={isActive(pathname, "/projects")}
            reason={null}
          />
          <div className="min-h-4 flex-1" />
          <NavRow rail item={SETTINGS} active={isActive(pathname, "/settings")} reason={null} />
        </div>
        <div className="border-separator border-t pt-1 pb-1">
          <AccountMenu user={user} help={help} compact />
        </div>
      </nav>
    );
  }
  return (
    <nav aria-label="Main" className="flex h-full w-sidebar flex-col gap-0.5 px-2 py-1">
      <div className="flex h-10 items-center gap-1">
        <Link href="/" aria-label="OpenDash, home" className="flex min-w-0 flex-1 items-center px-1.5 text-foreground">
          <OpenDashLogo className="h-6" label={null} />
        </Link>
        <Button isIconOnly size="md" variant="ghost" aria-label="Hide sidebar" onPress={toggle}>
          <PanelLeft className="text-muted" />
        </Button>
        <Button
          isIconOnly
          size="md"
          variant="ghost"
          aria-label="Search (⌘K)"
          onPress={() => window.dispatchEvent(new Event(OPEN_SEARCH))}
        >
          <Search className="text-muted" />
        </Button>
      </div>
      <OrgSwitcher active={org} orgs={orgs} />
      <div className="h-2" />
      {canAsk ? (
        <Link
          href="/ask/new"
          className="flex h-8 items-center gap-2.5 rounded-xl border border-border bg-surface px-2 text-body font-medium hover:bg-default"
        >
          <SquarePen className="size-4" aria-hidden />
          <span className="flex-1">New question</span>
          <kbd className="rounded-sm border border-border px-1.5 font-sans text-micro text-muted">N</kbd>
        </Link>
      ) : (
        <Tooltip delay={300}>
          <Tooltip.Trigger>
            <span
              aria-disabled
              className="flex h-8 cursor-not-allowed items-center gap-2.5 rounded-xl border border-border px-2 text-body font-medium text-muted-tertiary"
            >
              <SquarePen className="size-4" aria-hidden />
              <span className="flex-1">New question</span>
            </span>
          </Tooltip.Trigger>
          <Tooltip.Content placement="right">{viewer ? VIEWER : hasData ? SOON : NEEDS_DATA}</Tooltip.Content>
        </Tooltip>
      )}
      <div className="h-2.5" />
      {/* The navigation scrolls between the top and the foot when it doesn't fit (Settings open on a short screen). */}
      <div className="-mx-2 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2">
        {NAV.map((item) => {
          const active = isActive(pathname, item.href);
          const reason = item.needsData && !hasData ? NEEDS_DATA : item.soon ? SOON : null;
          return (
            <NavRow
              key={item.href}
              item={item}
              active={active}
              reason={reason}
              count={item.href === "/insights" ? insights : 0}
            />
          );
        })}
        <div className="flex flex-col gap-0.5 pt-4">
          <span className="px-2 pb-1 text-small text-muted-tertiary">Projects</span>
          {projects.map((p) => {
            const on = pathname === `/projects/${p.id}`;
            return (
              <Link
                key={p.id}
                href={`/projects/${p.id}`}
                aria-current={on ? "page" : undefined}
                className={`flex h-8 items-center gap-2.5 rounded-xl px-2 text-body text-foreground ${on ? "bg-default" : "hover:bg-default"}`}
              >
                <ProjectAvatar id={p.id} name={p.name} />
                <span className="truncate">{p.name}</span>
              </Link>
            );
          })}
          <Link
            href="/projects"
            aria-current={pathname === "/projects" ? "page" : undefined}
            className={`flex h-8 items-center gap-2.5 rounded-xl px-2 text-body ${pathname === "/projects" ? "bg-default text-foreground" : "text-muted hover:bg-default"}`}
          >
            <FolderKanban className="size-4.5" aria-hidden />
            All projects
          </Link>
        </div>
        <div className="min-h-4 flex-1" />
        <div className="flex flex-col gap-2 pb-2">
          <SetupCard setup={setup} />
          {status ? <StatusPill status={status} /> : null}
        </div>
        <NavRow item={SETTINGS} active={isActive(pathname, "/settings")} reason={null} />
      </div>
      <div className="border-separator border-t pt-1 pb-1">
        <AccountMenu user={user} help={help} />
      </div>
    </nav>
  );
}

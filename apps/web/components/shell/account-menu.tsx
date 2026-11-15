"use client";

import { Button, Dropdown, Header, Label, Separator } from "@heroui/react";
import { authRoutes } from "@opendash/auth/routes";
import {
  Activity,
  BookOpen,
  Check,
  ChevronsUpDown,
  LifeBuoy,
  LogOut,
  Monitor,
  Moon,
  Repeat,
  ShieldCheck,
  Sun,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import type { HelpLink } from "@/lib/help";
import { signOutTo } from "@/lib/sign-out";

export interface AccountUser {
  name: string;
  email: string;
}

const THEMES = [
  { id: "light", label: "Light", icon: Sun },
  { id: "dark", label: "Dark", icon: Moon },
  { id: "system", label: "Same as the system", icon: Monitor },
] as const;

const HELP_ICONS = { docs: BookOpen, support: LifeBuoy, status: Activity } as const;

/** "Sam Rivera" → "SR"; an email's first letter when there's no name. */
const initials = (u: AccountUser) =>
  (u.name.trim() || u.email)
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w.slice(0, 1).toUpperCase())
    .join("");

/**
 * You, at the bottom of the sidebar: your security and your routines, the theme (light, dark, or the system's), where
 * to get help on this instance (what its operator set: docs, support, status), and signing out. The workspace is chosen at the top; its settings are in the sidebar.
 */
export function AccountMenu({
  user,
  help = [],
  compact = false,
}: {
  user: AccountUser;
  help?: HelpLink[];
  /** On the collapsed sidebar: your initials alone. */
  compact?: boolean;
}) {
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  // The theme is known in the browser only: until then no choice is marked, so the server's page matches.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const current = mounted ? (theme ?? "system") : null;

  async function onAction(key: string | number) {
    const id = String(key);
    if (id === "security") router.push(authRoutes.security);
    else if (id === "routines") router.push("/routines?tab=yours");
    else if (id === "sign-out") await signOutTo(authRoutes.signIn);
    else if (id.startsWith("theme-")) setTheme(id.slice("theme-".length));
  }

  return (
    <Dropdown>
      {compact ? (
        <Button isIconOnly variant="ghost" className="size-10" aria-label={`Your account: ${user.name}`}>
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-default text-micro font-semibold text-muted">
            {initials(user)}
          </span>
        </Button>
      ) : (
        <Button variant="ghost" className="h-11 w-full justify-start gap-2.5 px-1.5" aria-label="Your account">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-default text-micro font-semibold text-muted">
            {initials(user)}
          </span>
          <span className="flex min-w-0 flex-1 flex-col items-start">
            <span className="w-full truncate text-start text-body font-medium text-foreground">{user.name}</span>
            <span className="w-full truncate text-start text-small text-muted-tertiary">{user.email}</span>
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-tertiary" aria-hidden />
        </Button>
      )}
      <Dropdown.Popover placement={compact ? "right bottom" : "top start"} className="min-w-60">
        <Dropdown.Menu onAction={onAction}>
          <Dropdown.Section>
            <Header>{user.email}</Header>
            <Dropdown.Item id="security" textValue="Security">
              <ShieldCheck className="size-4 text-muted" aria-hidden />
              <Label>Security</Label>
            </Dropdown.Item>
            <Dropdown.Item id="routines" textValue="Your routines">
              <Repeat className="size-4 text-muted" aria-hidden />
              <Label>Your routines</Label>
            </Dropdown.Item>
          </Dropdown.Section>
          <Separator />
          <Dropdown.Section>
            <Header>Theme</Header>
            {THEMES.map((t) => (
              <Dropdown.Item key={t.id} id={`theme-${t.id}`} textValue={t.label}>
                <t.icon className="size-4 text-muted" aria-hidden />
                <Label>{t.label}</Label>
                {current === t.id ? <Check className="ms-auto size-3.5 text-muted" aria-hidden /> : null}
              </Dropdown.Item>
            ))}
          </Dropdown.Section>
          <Separator />
          {help.length ? (
            <>
              <Dropdown.Section>
                <Header>Help</Header>
                {help.map((h) => {
                  const Icon = HELP_ICONS[h.id];
                  return (
                    <Dropdown.Item key={h.id} id={`help-${h.id}`} textValue={h.label} href={h.href} target="_blank">
                      <Icon className="size-4 text-muted" aria-hidden />
                      <Label>{h.label}</Label>
                    </Dropdown.Item>
                  );
                })}
              </Dropdown.Section>
              <Separator />
            </>
          ) : null}
          <Dropdown.Item id="sign-out" textValue="Sign out">
            <LogOut className="size-4 text-muted" aria-hidden />
            <Label>Sign out</Label>
          </Dropdown.Item>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}

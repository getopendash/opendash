"use client";

import { Button, Dropdown, Label, Separator } from "@heroui/react";
import { authClient } from "@opendash/auth/client";
import { authRoutes } from "@opendash/auth/routes";
import { Check, ChevronsUpDown, Plus } from "lucide-react";
import { useRouter } from "next/navigation";

export interface OrgOption {
  id: string;
  name: string;
}

function Avatar({ name, size = "md" }: { name: string; size?: "sm" | "md" }) {
  return (
    <span
      className={`flex shrink-0 items-center justify-center rounded-md bg-avatar-sky font-semibold text-avatar-foreground ${
        size === "md" ? "size-5 text-micro" : "size-4.5 text-micro"
      }`}
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

/**
 * The workspace, under the logo: switch to another of yours, or make one. Its settings are in the sidebar, and you
 * (security, the theme, signing out) are at its foot.
 */
export function OrgSwitcher({
  active,
  orgs,
  compact = false,
}: {
  active: OrgOption;
  orgs: OrgOption[];
  /** On the collapsed sidebar: the workspace's avatar alone. */
  compact?: boolean;
}) {
  const router = useRouter();

  async function onAction(key: string | number) {
    const id = String(key);
    if (id === "create") {
      router.push(authRoutes.createOrganization);
    } else if (id !== active.id) {
      await authClient.organization.setActive({ organizationId: id });
      router.push("/");
      router.refresh();
    }
  }

  return (
    <Dropdown>
      {compact ? (
        <Button isIconOnly variant="ghost" size="lg" aria-label={`Switch workspace: ${active.name}`}>
          <Avatar name={active.name} />
        </Button>
      ) : (
        <Button variant="ghost" className="h-8 w-full justify-start gap-2.5 px-2" aria-label="Switch workspace">
          <Avatar name={active.name} />
          <span className="min-w-0 flex-1 truncate text-start text-body font-medium text-foreground">
            {active.name}
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-tertiary" aria-hidden />
        </Button>
      )}
      <Dropdown.Popover placement={compact ? "right top" : "bottom start"} className="min-w-56">
        <Dropdown.Menu onAction={onAction}>
          {orgs.map((org) => (
            <Dropdown.Item key={org.id} id={org.id} textValue={org.name}>
              <Avatar name={org.name} size="sm" />
              <Label className="truncate">{org.name}</Label>
              {org.id === active.id ? <Check className="ms-auto size-3.5 text-muted" aria-hidden /> : null}
            </Dropdown.Item>
          ))}
          <Separator />
          <Dropdown.Item id="create" textValue="New workspace">
            <Plus className="size-4 text-muted" aria-hidden />
            <Label>New workspace</Label>
          </Dropdown.Item>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}

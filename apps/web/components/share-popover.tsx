"use client";

import { Button, Description, Popover, Radio, RadioGroup, toast } from "@heroui/react";
import { FolderKanban, Link2, Lock, Share2, Users } from "lucide-react";
import type { ReactNode } from "react";

export type Visibility = "private" | "project" | "org";

/**
 * The sharing popover, for a conversation or a dashboard: only its owner, its project's people (when it's in a
 * project), or everyone in the organization.
 */
export function SharePopover({
  title,
  org,
  project,
  value,
  pending,
  everyone,
  path,
  onChange,
  children,
}: {
  title: string;
  org: string;
  /** The project it's in: offers sharing with its people. */
  project?: string | null;
  value: Visibility;
  pending: boolean;
  /** What everyone else can do with it once shared. */
  everyone: string;
  /** The page's path, for Copy link. */
  path: string;
  onChange: (next: Visibility) => void;
  /** More ways to share, above the footer (a report's public link). */
  children?: ReactNode;
}) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${path}`);
      toast.success("Link copied.");
    } catch {
      toast.danger("Couldn't copy the link.");
    }
  };
  const options = [
    { value: "private", icon: Lock, label: "Only you", description: "Private. Nobody else can open it." },
    ...(project
      ? [{ value: "project", icon: FolderKanban, label: `People in ${project}`, description: everyone } as const]
      : []),
    { value: "org", icon: Users, label: `Everyone at ${org}`, description: everyone },
  ] as const;
  return (
    <Popover>
      <Button size="sm" variant="ghost">
        <Share2 className="size-3.5" aria-hidden />
        Share
      </Button>
      <Popover.Content placement="bottom end" className="w-96">
        <Popover.Dialog className="flex flex-col gap-2 p-1">
          <Popover.Heading className="px-2.5 pt-2 text-body font-medium">{title}</Popover.Heading>
          <RadioGroup
            aria-label="Who can read it"
            value={value}
            isDisabled={pending}
            onChange={(next) => onChange(next as Visibility)}
            className="flex flex-col gap-0.5"
          >
            {options.map((o) => (
              <Radio key={o.value} value={o.value} className="mt-0 rounded-lg px-2.5 py-2 data-selected:bg-default">
                <Radio.Content className="flex items-center gap-2.5 text-body">
                  <Radio.Control>
                    <Radio.Indicator />
                  </Radio.Control>
                  <o.icon className="size-3.5 text-muted" aria-hidden />
                  {o.label}
                </Radio.Content>
                <Description className="pl-7 text-small text-muted">{o.description}</Description>
              </Radio>
            ))}
          </RadioGroup>
          {children}
          <div className="flex items-center justify-between gap-3 border-t border-border px-2.5 pt-2 pb-1.5">
            <span className="text-small text-muted">
              {children ? `Copy link is for people in ${org}.` : `Only people in ${org} can open the link.`}
            </span>
            <Button size="sm" variant="outline" isDisabled={value === "private"} onPress={copy}>
              <Link2 className="size-3.5" aria-hidden />
              Copy link
            </Button>
          </div>
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  );
}

import type { ReactNode } from "react";

/**
 * The settings pages' frame: the page's width and padding. Its pages are listed under Settings in
 * the sidebar (the workspace's, then your own); Usage, AI, Health, Activity and Slack are for owners and admins.
 */
export function SettingsFrame({ children }: { children: ReactNode }) {
  return (
    <div className="flex-1 overflow-y-auto px-6 pt-6 pb-16 @2xl/page:px-8">
      <div className="flex min-w-0 max-w-4xl flex-col gap-6">{children}</div>
    </div>
  );
}

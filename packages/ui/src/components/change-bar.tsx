import { Sparkles } from "lucide-react";
import type { ReactNode } from "react";

/**
 * What just changed on the page, and the way back: "The analyst changed 2 things · v12 → v14", then
 * History and Undo. It says so while the change is the one shown; the page takes it away after.
 */
export function ChangeBar({
  title,
  detail,
  actions,
  icon,
}: {
  title: ReactNode;
  detail?: ReactNode;
  /** Its buttons, at the end (History, Undo). */
  actions?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div
      role="status"
      className="flex min-h-8 flex-wrap items-center gap-x-2 gap-y-1 rounded-xl bg-accent-soft py-1 pr-1 pl-2.5"
    >
      <span className="flex shrink-0 text-accent" aria-hidden>
        {icon ?? <Sparkles className="size-3.5" />}
      </span>
      <span className="text-body font-medium text-accent-soft-foreground">{title}</span>
      <span className="min-w-0 flex-1 text-body text-muted">{detail}</span>
      {actions ? <span className="flex shrink-0 items-center gap-1">{actions}</span> : null}
    </div>
  );
}

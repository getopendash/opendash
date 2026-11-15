import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/** Title block for auth screens, with the optional icon badge used on message screens. */
export function AuthHeading({
  icon: Icon,
  title,
  children,
}: {
  icon?: LucideIcon;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      {Icon ? (
        <span className="mb-3 flex size-10 items-center justify-center rounded-2xl border border-border bg-surface-secondary text-foreground">
          <Icon className="size-4.5" aria-hidden />
        </span>
      ) : null}
      <h1 className="text-title text-balance">{title}</h1>
      {children ? <p className="text-body text-muted">{children}</p> : null}
    </div>
  );
}

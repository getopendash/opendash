import { Spinner } from "@heroui/react";
import { CircleX } from "lucide-react";
import Link from "next/link";

export interface StatusPillData {
  tone: "accent" | "danger";
  label: string;
  href: string;
}

/** The pill at the bottom of the sidebar: a source being learned, or sources that need attention. */
export function StatusPill({ status }: { status: StatusPillData }) {
  const tone =
    status.tone === "danger"
      ? "bg-danger-soft text-danger-soft-foreground"
      : "bg-accent-soft text-accent-soft-foreground";
  return (
    <Link
      href={status.href}
      className={`flex h-6 min-w-0 items-center gap-1.5 self-start rounded-full px-2.5 text-small font-medium hover:underline ${tone}`}
    >
      {status.tone === "danger" ? (
        <CircleX className="size-3 shrink-0" aria-hidden />
      ) : (
        <Spinner size="sm" className="size-3 shrink-0" aria-hidden />
      )}
      <span className="truncate">{status.label}</span>
    </Link>
  );
}

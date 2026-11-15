import Link from "next/link";

/** Insights' tabs: what's open, what's closed, and what's watched (every routine's metrics). */
export function InsightsTabs({
  tab,
  openCount,
  watched,
}: {
  tab: "open" | "closed" | "watching";
  openCount: number;
  watched: number;
}) {
  return (
    <nav aria-label="Insights" className="flex w-fit items-center gap-0.5 rounded-xl bg-surface-secondary p-0.5">
      {[
        { id: "open", href: "/insights", label: `Open · ${openCount}` },
        { id: "closed", href: "/insights?status=closed", label: "Closed" },
        { id: "watching", href: "/insights/watching", label: `Watching · ${watched}` },
      ].map((t) => (
        <Link
          key={t.id}
          href={t.href}
          aria-current={t.id === tab ? "page" : undefined}
          className={`rounded-lg px-2.5 py-1 text-small ${t.id === tab ? "bg-surface font-medium" : "text-muted hover:text-foreground"}`}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

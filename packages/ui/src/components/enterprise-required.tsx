import type { ReactNode } from "react";

/**
 * Where an enterprise feature would be, on an instance whose license doesn't cover it: what the feature does and how to
 * turn it on. Settings pages show it in place of the feature's setup.
 */
export function EnterpriseRequired({
  title,
  items,
  children,
}: {
  title: string;
  /** What the feature does, a line each. */
  items: string[];
  /** How to turn it on. */
  children?: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-dashed border-border px-5 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex h-5 items-center rounded-full bg-accent-soft px-2 text-small font-medium text-accent-soft-foreground">
          Enterprise
        </span>
        <h2 className="text-body font-semibold">{title}</h2>
      </div>
      <ul className="flex list-disc flex-col gap-1 ps-5 text-body text-muted">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      {children ? <div className="text-small text-muted">{children}</div> : null}
    </section>
  );
}

import type { DefinitionUsage } from "@opendash/core";
import { FlaskConical, LayoutDashboard, type LucideIcon, ShieldCheck, Sigma, Target } from "lucide-react";
import Link from "next/link";
import { Fragment, type ReactNode } from "react";

function Row({ icon: Icon, label, children }: { icon: LucideIcon; label: string; children: ReactNode }) {
  return (
    <li className="flex min-h-8 items-center gap-2.5 border-b border-border py-1.5 text-body">
      <Icon className="size-3.5 shrink-0 text-muted" aria-hidden />
      <span className="w-28 shrink-0 text-muted">{label}</span>
      <span className="min-w-0 flex-1 text-small">{children}</span>
    </li>
  );
}

function Links({ items, more = 0 }: { items: { id: string; title: string; href: string }[]; more?: number }) {
  return (
    <>
      {items.map((i, n) => (
        <Fragment key={i.id}>
          {n ? <span className="text-muted-tertiary"> · </span> : null}
          <Link href={i.href} className="text-link hover:underline">
            {i.title}
          </Link>
        </Fragment>
      ))}
      {more ? (
        <span className="text-muted-tertiary">
          {items.length ? " · " : ""}+{more} private
        </span>
      ) : null}
    </>
  );
}

/** A definition's Used by: what moves when this definition changes. Private dashboards of others are counted, not named. */
export function UsedBy({ usage, kind }: { usage: DefinitionUsage; kind: "dataset" | "metric" }) {
  const { metrics, dashboards, verifiedQueries, evalQuestions, goals } = usage;
  const dashboardCount = dashboards.visible.length + dashboards.hidden;
  const nothing = !metrics.length && !dashboardCount && !verifiedQueries.length && !evalQuestions && !goals.length;
  if (nothing) {
    return (
      <p className="text-small text-muted-tertiary">
        Nothing depends on it yet: no {kind === "dataset" ? "metrics, " : ""}dashboards, verified queries, goals or eval
        questions.
      </p>
    );
  }
  return (
    <ul className="flex flex-col">
      {kind === "dataset" && metrics.length ? (
        <Row icon={Sigma} label="Metrics">
          <Links items={metrics.map((m) => ({ ...m, href: `/knowledge/metrics/${m.id}` }))} />
        </Row>
      ) : null}
      {dashboardCount ? (
        <Row icon={LayoutDashboard} label="Dashboards">
          <Links
            items={dashboards.visible.map((d) => ({ ...d, href: `/dashboards/${d.id}` }))}
            more={dashboards.hidden}
          />
        </Row>
      ) : null}
      {verifiedQueries.length ? (
        <Row icon={ShieldCheck} label="Verified queries">
          <Links items={verifiedQueries.map((q) => ({ ...q, href: `/knowledge/verified/${q.id}` }))} />
        </Row>
      ) : null}
      {goals.length ? (
        <Row icon={Target} label="Goals">
          <Links items={goals.map((g) => ({ ...g, href: "/settings/goals" }))} />
        </Row>
      ) : null}
      {evalQuestions ? (
        <Row icon={FlaskConical} label="Eval questions">
          <span className="text-muted">{evalQuestions}</span>
        </Row>
      ) : null}
    </ul>
  );
}

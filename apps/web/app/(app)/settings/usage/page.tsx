import { PRICE_SOURCES, priceOf, spendView, usageSummary } from "@opendash/core";
import { withTenant } from "@opendash/db";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { TopBar } from "@/components/shell/top-bar";
import { SettingsFrame } from "@/components/team/settings-frame";
import { SpendLimits } from "@/components/usage/spend-limits";
import { UsageByDay, UsageByModel } from "@/components/usage/usage-tables";
import { requireTenant } from "@/lib/auth";
import { costLabel, shortDate, tokens, usd } from "@/lib/format";
import { canManageTeam } from "@/lib/team";

export const metadata: Metadata = { title: "Usage · OpenDash" };

const DAYS = 30;
const dollars = (n: number) => (Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`);
const price = (model: string) => {
  const p = priceOf(model);
  return p ? `${dollars(p.input)} in · ${dollars(p.cacheRead)} from cache · ${dollars(p.output)} out` : null;
};

/** What answering the team's questions used and cost, and the spend limits. Owners and admins. */
export default async function UsagePage() {
  const viewer = await requireTenant();
  if (!canManageTeam(viewer.role)) redirect("/settings/members");
  const [summary, limits] = await Promise.all([
    withTenant(viewer.ctx, (tx) => usageSummary(tx, viewer.ctx.orgId, { days: DAYS })),
    withTenant(viewer.ctx, (tx) => spendView(tx, viewer.ctx.orgId)),
  ]);
  const t = summary.totals;
  const per = t.questions ? t.costUsd / t.questions : 0;
  const tiles = [
    {
      label: "Questions answered",
      value: t.questions.toLocaleString("en-US"),
      note: `by ${t.people} ${t.people === 1 ? "person" : "people"}`,
    },
    {
      label: "Model calls",
      value: t.calls.toLocaleString("en-US"),
      note: t.questions ? `${(t.calls / t.questions).toFixed(1)} per question` : "—",
    },
    { label: "Tokens", value: tokens(t.tokens), note: `${tokens(t.cachedTokens)} read from cache` },
    {
      label: "Cost",
      value: costLabel(t),
      note: t.questions && t.unpriced < t.calls ? `${usd(per)} per question` : "—",
    },
  ];
  return (
    <>
      <TopBar crumbs={[{ label: "Settings", href: "/settings/members" }, { label: "Usage" }]} />
      <SettingsFrame>
        <div className="flex flex-col gap-1.5">
          <h1 className="text-display">Usage</h1>
          <p className="text-body text-muted">
            What answering your team's questions used since {shortDate(summary.since)}: model calls, tokens and what
            they cost. Each call is priced when it's made.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3 @2xl/page:grid-cols-4">
          {tiles.map((x) => (
            <div key={x.label} className="flex flex-col gap-1 rounded-2xl border border-border bg-surface px-4 py-3.5">
              <span className="text-small font-medium text-muted">{x.label}</span>
              <span className="text-number-lg font-semibold tabular-nums">{x.value}</span>
              <span className="text-small text-muted-tertiary">{x.note}</span>
            </div>
          ))}
        </div>
        <SpendLimits initial={limits} />
        {t.calls ? (
          <>
            <section className="flex flex-col gap-2">
              <h2 className="text-body font-semibold">By day</h2>
              <UsageByDay days={summary.byDay} of={DAYS} />
            </section>
            <section className="flex flex-col gap-2">
              <h2 className="text-body font-semibold">By model</h2>
              <UsageByModel models={summary.byModel.map((r) => ({ ...r, price: price(r.model) }))} />
            </section>
          </>
        ) : (
          <p className="rounded-2xl border border-dashed border-border px-6 py-12 text-center text-body text-muted">
            No questions in the last {DAYS} days.
          </p>
        )}
        <p className="text-small text-muted-tertiary">
          Priced at list prices (
          {PRICE_SOURCES.map((source, i) => (
            <span key={source.url}>
              {i > 0 ? "; " : ""}
              <a href={source.url} className="underline" target="_blank" rel="noreferrer">
                {source.makers}
              </a>{" "}
              as of {shortDate(`${source.asOf}T12:00:00Z`)}
            </span>
          ))}
          ), when each call was made: a later price change doesn't rewrite past calls. With your own provider, its bill
          is the source of truth.
        </p>
      </SettingsFrame>
    </>
  );
}

import { isOwnerRole } from "@opendash/auth";
import { ENTERPRISE_FEATURE_LABELS, ENTERPRISE_FEATURES, type License } from "@opendash/core/enterprise";
import { EnterpriseRequired } from "@opendash/ui";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { TopBar } from "@/components/shell/top-bar";
import { SettingsFrame } from "@/components/team/settings-frame";
import { enterprise, licensingShown } from "@/enterprise";
import { requireTenant } from "@/lib/auth";

export const metadata: Metadata = { title: "License · OpenDash" };
export const dynamic = "force-dynamic";

const KEPT =
  "What's set up keeps running: sign-in through single sign-on, requiring it, directory sync and audit recording. Changing them waits for a valid key.";

// Keys expire at an instant the licensor chose in UTC (a date alone: that day's end), so the date is UTC's.
const date = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

function Chip({ tone, children }: { tone: "success" | "warning" | "danger" | "default"; children: string }) {
  const tones = {
    success: "bg-success-soft text-success-soft-foreground",
    warning: "bg-warning-soft text-warning-soft-foreground",
    danger: "bg-danger-soft text-danger-soft-foreground",
    default: "bg-surface-secondary text-muted",
  };
  return (
    <span className={`inline-flex h-5 items-center rounded-full px-2 text-small font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}

function Terms({ license }: { license: License }) {
  const rows: [string, string][] = [
    ["Licensed to", license.licensee],
    ["Covers", license.features.map((f) => ENTERPRISE_FEATURE_LABELS[f]).join(", ") || "Nothing this version knows"],
    ["Instance", license.instance ?? "Any"],
    ["Seats", license.seats === null ? "No limit" : `Up to ${license.seats}`],
    ["Expires", date(license.expiresAt)],
  ];
  return (
    <dl className="flex flex-col gap-2 text-body">
      {rows.map(([term, value]) => (
        <div key={term} className="flex gap-6">
          <dt className="w-24 shrink-0 text-muted">{term}</dt>
          <dd className="min-w-0 break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

const WHAT = [
  "Single sign-on through your identity provider (OIDC or SAML), and requiring it for your domain",
  "Directory sync: your identity provider adds, changes and removes people (SCIM 2.0)",
  "The audit log's tamper-evident chain, retention for years, and exports",
];

/** The instance's Enterprise license: what its key covers, or why it's off. Owners; not on the licensor's service. */
export default async function LicensePage() {
  const viewer = await requireTenant();
  if (!isOwnerRole(viewer.role) || !licensingShown()) redirect("/settings/members");
  const gate = enterprise();
  const status = gate.status();
  const keyHow = (
    <>
      Set <code className="font-mono">OPENDASH_LICENSE_KEY</code> in the instance's settings and restart it. The key is
      checked offline, so an instance without internet access works.
    </>
  );

  let body: ReactNode;
  if (status.state === "valid" || status.state === "expired") {
    body = (
      <section className="flex flex-col gap-4 rounded-2xl border border-border px-5 py-4">
        <div className="flex flex-wrap items-center gap-2">
          {status.state === "valid" ? <Chip tone="success">Licensed</Chip> : <Chip tone="warning">Expired</Chip>}
          {status.state === "valid" && status.expiresSoon ? <Chip tone="warning">Expires soon</Chip> : null}
          <span className="text-small text-muted-tertiary">Checked when the instance started</span>
        </div>
        <Terms license={status.license} />
        {status.state === "expired" ? <p className="text-small text-muted">{KEPT}</p> : null}
      </section>
    );
  } else if (status.state === "invalid") {
    body = (
      <section className="flex flex-col gap-3 rounded-2xl border border-border px-5 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <Chip tone="danger">Not accepted</Chip>
          <span className="text-body">{status.reason}</span>
        </div>
        <p className="text-small text-muted">
          {gate.production
            ? "Until it's replaced, this instance treats enterprise features as unlicensed. "
            : "Outside production that doesn't matter: enterprise features can be set up for development and testing. "}
          {keyHow}
        </p>
      </section>
    );
  } else if (status.state === "community") {
    body = <p className="text-body text-muted">This build of OpenDash doesn't include the enterprise features.</p>;
  } else if (gate.production) {
    body = (
      <EnterpriseRequired title="Enterprise features are off on this instance" items={WHAT}>
        {keyHow}
      </EnterpriseRequired>
    );
  } else {
    body = (
      <section className="flex flex-col gap-2 rounded-2xl border border-border px-5 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <Chip tone="default">No license key</Chip>
        </div>
        <p className="text-body text-muted">
          This instance isn't running in production, so the enterprise features can be set up without a key, as their
          license allows for development and testing:{" "}
          {ENTERPRISE_FEATURES.map((f) => ENTERPRISE_FEATURE_LABELS[f])
            .join(", ")
            .toLowerCase()}
          .
        </p>
      </section>
    );
  }

  return (
    <>
      <TopBar crumbs={[{ label: "Settings", href: "/settings/members" }, { label: "License" }]} />
      <SettingsFrame>
        <div className="flex flex-col gap-1.5">
          <h1 className="text-display">License</h1>
          <p className="text-body text-muted">
            What this instance's Enterprise license covers. The key is part of the instance's settings, not the app's.
          </p>
        </div>
        {body}
        <p className="max-w-reading text-small text-muted-tertiary">
          If a key lapses, nothing that's set up stops: sign-in through single sign-on, requiring it, directory sync and
          audit recording keep running. Only changes to them wait, and owners see it here from 30 days before.
        </p>
      </SettingsFrame>
    </>
  );
}

import { Alert, buttonVariants } from "@heroui/react";
import { Database, Globe, Plus } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { TopBar } from "@/components/shell/top-bar";
import { needsAttention } from "@/components/sources/source-status";
import { SourcesTable } from "@/components/sources/sources-table";
import { authSettings } from "@/lib/auth";
import { canManageSources, egressAddresses, listSources } from "@/lib/sources";
import { currentWorkspace } from "@/lib/workspace";

export const metadata: Metadata = { title: "Sources · OpenDash" };

/** Data → Sources: the org's sources as a table, or how to connect the first one. */
export default async function SourcesPage() {
  const ws = await currentWorkspace();
  const sources = ws.sources > 0 ? await listSources({ orgId: ws.org.id, userId: ws.user.id }) : [];
  const canConnect = canManageSources(ws.role);
  const egress = (await authSettings()).edition === "cloud" ? egressAddresses() : [];
  const attention = sources.filter(needsAttention);
  const [first] = attention;
  return (
    <>
      <TopBar
        crumbs={[{ label: "Data", href: "/data/sources" }, { label: "Sources" }]}
        action={
          canConnect ? (
            <Link href="/data/sources/new" className={`${buttonVariants({ size: "sm" })} gap-1`}>
              <Plus className="size-3.5" aria-hidden />
              Connect source
            </Link>
          ) : undefined
        }
      />
      <div className="flex-1 overflow-y-auto px-8 pt-8 pb-16">
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-1.5">
            <h1 className="text-display">Sources</h1>
            <p className="text-body text-muted">
              Databases OpenDash reads from. Every connection uses a read-only user and runs queries in place.
            </p>
          </div>
          {first ? (
            <Alert status="danger">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Title>
                  {attention.length === 1
                    ? `${first.name}: ${first.statusDetail ?? "OpenDash couldn't learn this source."}`
                    : `${attention.length} sources need attention: ${attention.map((s) => s.name).join(", ")}`}
                </Alert.Title>
              </Alert.Content>
              {attention.length === 1 ? (
                <Link
                  href={`/data/sources/${first.id}${(first.status === "error" || first.status === "failing") && canConnect ? "/reconnect" : ""}`}
                  className={buttonVariants({ size: "sm", variant: "secondary" })}
                >
                  {(first.status === "error" || first.status === "failing") && canConnect ? "Reconnect" : "View"}
                </Link>
              ) : null}
            </Alert>
          ) : null}
          {sources.length > 0 ? <SourcesTable sources={sources} now={Date.now()} canManage={canConnect} /> : null}
          {egress.length ? (
            <div className="flex gap-2.5 rounded-2xl bg-accent-soft px-3 py-2.5">
              <Globe className="mt-0.5 size-4 shrink-0 text-accent-soft-foreground" aria-hidden />
              <div className="flex flex-col gap-0.5">
                <p className="text-body font-medium text-accent-soft-foreground">
                  OpenDash Cloud connects from {egress.join(" and ")}
                </p>
                <p className="text-body text-muted">Add them to your database allowlist.</p>
              </div>
            </div>
          ) : null}
          {ws.sources === 0 ? (
            <div className="flex flex-col items-center gap-3 rounded-2xl border border-border px-6 py-14 text-center">
              <span className="flex size-10 items-center justify-center rounded-2xl border border-border bg-surface-secondary">
                <Database className="size-4.5" aria-hidden />
              </span>
              <div className="flex max-w-form flex-col gap-1">
                <h2 className="text-heading">No sources yet</h2>
                <p className="text-body text-muted">
                  Connect a database to start asking questions about {ws.org.name}. OpenDash only reads, through a user
                  that can't change your data.
                </p>
              </div>
              {canConnect ? (
                <Link href="/data/sources/new" className={`${buttonVariants({ size: "md" })} mt-2 gap-1`}>
                  <Plus className="size-3.5" aria-hidden />
                  Connect source
                </Link>
              ) : (
                <p className="text-small text-muted">An owner or admin can connect one.</p>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}

import { Alert } from "@heroui/react";
import { BUDGETS } from "@opendash/core";
import { notFound, redirect } from "next/navigation";
import { SourceSettingsForm } from "@/components/sources/source-settings-form";
import { requireTenant } from "@/lib/auth";
import { canManageSources, sourcePage } from "@/lib/sources";

/**
 * Reconnect: when OpenDash can't sign in (or the password is being rotated), a new password for the same user or
 * another one, checked like a new source, then saved and the source learned again. What's affected (datasets, dashboards,
 * routines) is listed once those are.
 */
export default async function SourceReconnect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const viewer = await requireTenant();
  const data = await sourcePage(viewer.ctx.orgId, viewer.user.id, id);
  if (!data) notFound();
  if (!canManageSources(viewer.role)) redirect(`/data/sources/${id}`);
  const { source } = data;
  return (
    <div className="flex max-w-wizard flex-col gap-6">
      {source.status === "error" || source.status === "failing" ? (
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>OpenDash couldn't connect to {source.name}</Alert.Title>
            <Alert.Description>
              {source.statusDetail ?? "Its last check failed."}{" "}
              {source.status === "error"
                ? "Nothing is queried until a check passes."
                : "Its queries fail until it's fixed."}
            </Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
      <div className="flex flex-col gap-1">
        <h2 className="text-heading">Update credentials</h2>
        <p className="text-body text-muted">
          A new password for {source.user}, or a different read-only user. It's checked before anything is saved.
        </p>
      </div>
      <SourceSettingsForm source={source} mode="reconnect" queuedWarningMs={BUDGETS.connectionTest.queuedWarningMs} />
    </div>
  );
}

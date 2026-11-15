"use client";

import { Button, toast } from "@heroui/react";
import { isDefinedError } from "@opendash/api/client";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { api, apiQueries } from "@/lib/api";

/**
 * The draft, above the dashboard, for its owner and its editors: while the draft is shown, Publish (its owner's) makes
 * it the next version (the one others open); while the version is shown, a way to the draft. Publishing is the owner's
 * press, never the analyst's nor an editor's.
 */
export function DraftBar({
  dashboardId,
  revision,
  showing,
  hasVersion,
  unverified = [],
  canPublish = true,
  editors = 0,
  savedBy = null,
}: {
  dashboardId: string;
  /** The draft's revision: Publish publishes this one, never a draft saved since. */
  revision: string;
  showing: boolean;
  hasVersion: boolean;
  /** Queries reading data no admin verified (the analyst's SQL, an unreleased definition): said before Publish. */
  unverified?: { title: string; reads: "unverified" | "table" | "service" }[];
  /** Its owner publishes; an editor sees the draft and changes it, and is told its owner publishes it. */
  canPublish?: boolean;
  /** For its owner: how many people it's shared with to edit, who see the draft too. */
  editors?: number;
  /**
   * Who saved the draft last, when it's someone other than this viewer: its code is theirs, so the actions it asks
   * for (a record's work, a row's action) are off here until the viewer saves it or its owner publishes it.
   */
  savedBy?: string | null;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const pathname = usePathname();
  const search = useSearchParams();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  // The address with the draft on or off, its filters kept (read from the router, so it renders on the server too).
  const address = (draft: boolean) => {
    const params = new URLSearchParams(search.toString());
    if (draft) params.set("draft", "1");
    else params.delete("draft");
    const s = params.toString();
    return `${pathname}${s ? `?${s}` : ""}`;
  };
  const publish = async () => {
    setBusy(true);
    try {
      const { version } = await api.dashboards.publish({ dashboardId, revision });
      toast.success(`Published as version ${version}.`);
      // Its versions and the conversations' lists of what they built say so too.
      void queryClient.invalidateQueries({ queryKey: apiQueries.dashboards.key() });
      router.replace(address(false));
      router.refresh();
    } catch (e) {
      toast.danger(isDefinedError(e) ? (e as { message: string }).message : "Couldn't publish it.");
    } finally {
      setBusy(false);
    }
  };
  if (!showing) {
    return (
      <p className="flex items-center gap-3 border-b border-border bg-surface-secondary px-6 py-1.5 text-small text-muted">
        {!canPublish
          ? "There's a draft of this, shared with you to edit."
          : editors
            ? "You have a draft of this, yours and its editors'."
            : "You have a draft of this, only yours."}
        <Link href={address(true)} className="text-foreground underline">
          Open the draft
        </Link>
      </p>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-border bg-warning-soft px-6 py-1.5 text-small text-warning-soft-foreground">
      <span className="flex-1">
        {!canPublish
          ? "Draft: you and the people who edit it see it. Its owner publishes it."
          : editors
            ? "Draft: you and its editors see it until you publish it."
            : "Draft: only you see it until you publish it."}
        {savedBy
          ? canPublish
            ? ` Saved by ${savedBy}: its actions are off until you publish it or save it yourself.`
            : ` Saved by ${savedBy}: its actions are off until you save it yourself or its owner publishes it.`
          : ""}
      </span>

      {hasVersion ? (
        <Link href={address(false)} className="underline">
          See the published version
        </Link>
      ) : null}
      {canPublish ? (
        <Button
          size="sm"
          isDisabled={busy}
          onPress={() => (unverified.length && !confirming ? setConfirming(true) : void publish())}
        >
          {confirming ? "Publish anyway" : "Publish"}
        </Button>
      ) : null}

      {confirming ? (
        <div className="basis-full rounded-lg border border-warning/40 bg-surface px-3 py-2 text-small text-foreground">
          <p className="font-medium">
            {unverified.length === 1 ? "One of its queries reads" : `${unverified.length} of its queries read`} data no
            admin has verified. Everyone you share this with sees what it returns.
          </p>
          <ul className="mt-1 list-disc pl-5 text-muted">
            {unverified.slice(0, 6).map((u) => (
              <li key={u.title}>
                {u.title}:{" "}
                {u.reads === "table"
                  ? "the analyst's own SQL over the warehouse's tables"
                  : u.reads === "service"
                    ? "a connected service: each person sees it with their own account"
                    : "a definition not released yet"}
              </li>
            ))}
          </ul>
          <button type="button" className="mt-1 text-muted underline" onClick={() => setConfirming(false)}>
            Not yet
          </button>
        </div>
      ) : null}
    </div>
  );
}

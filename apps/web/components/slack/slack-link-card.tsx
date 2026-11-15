"use client";

import { Button, Chip, toast } from "@heroui/react";
import { Hash } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { unlinkMySlackAction } from "@/app/(app)/settings/security/actions";

/**
 * Your Slack account on your own Security page: which Slack account asks OpenDash as you here, with
 * Unlink; or how to link one, when this workspace has Slack.
 */
export function SlackLinkCard({
  teamName,
  linked,
}: {
  teamName: string;
  linked: { slackUserName: string | null; linkedAt: string } | null;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const unlink = async () => {
    setPending(true);
    const r = await unlinkMySlackAction();
    setPending(false);
    if (!r.ok) return void toast.danger(r.message);
    toast.success("Your Slack account is unlinked.");
    router.refresh();
  };
  return (
    <section
      aria-labelledby="slack-link-title"
      className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-2xl border border-border px-5 py-4"
    >
      <Hash className="size-5 shrink-0 text-muted" aria-hidden />
      <div className="flex min-w-64 flex-1 flex-col gap-1">
        <div className="flex items-center gap-2">
          <h2 id="slack-link-title" className="text-body font-medium">
            Slack
          </h2>
          <Chip size="sm" variant="soft" color={linked ? "success" : "default"}>
            {linked ? "Linked" : "Not linked"}
          </Chip>
        </div>
        <p className="text-small text-muted">
          {linked
            ? `${linked.slackUserName ? `${linked.slackUserName} in ${teamName}` : `Your account in ${teamName}`} asks OpenDash as you, with the access you have here.`
            : `Ask OpenDash in ${teamName} (its Agents tab, a direct message, or @OpenDash in a channel) and it sends you a private link to confirm it's you.`}
        </p>
      </div>
      {linked ? (
        <Button size="sm" variant="danger-soft" isPending={pending} onPress={() => void unlink()}>
          Unlink
        </Button>
      ) : null}
    </section>
  );
}

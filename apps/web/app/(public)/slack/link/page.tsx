import type { Metadata } from "next";
import { LinkAccount } from "@/components/slack/link-account";

export const metadata: Metadata = {
  title: "Link your Slack account · OpenDash",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/** Confirming a Slack account. Outside the app's layout, so a sign-in on the way keeps the link's token. */
export default function SlackLinkPage() {
  return (
    <main className="h-dvh">
      <LinkAccount />
    </main>
  );
}

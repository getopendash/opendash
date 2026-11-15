import type { WorkspaceSummary } from "./workspace";

/** The onboarding steps (Home's checklist, the sidebar's setup card). Invite is optional and isn't counted. */
export type SetupStepKey = "organization" | "data" | "starter-pack" | "ask" | "invite";

export interface SetupStep {
  key: SetupStepKey;
  label: string;
  /** Shorter form for "Next: …" in the sidebar card. */
  next: string;
  done: boolean;
  optional?: boolean;
  /** Shown on the right once done, e.g. the organization's name. */
  detail?: string;
  /** Where to go to do it, when that screen exists. */
  href?: string;
  actionLabel?: string;
  /** Under way (a source is being learned): the card shows `next` as it is, with a spinner. */
  inProgress?: boolean;
}

export interface SetupProgress {
  steps: SetupStep[];
  done: number;
  total: number;
  /** The first required step not done yet, or null when setup is finished. */
  next: SetupStep | null;
}

export function setupProgress(
  ws: Pick<WorkspaceSummary, "org" | "sources" | "sourceStates" | "members" | "asked" | "definitions">,
): SetupProgress {
  // Data counts once a source has been learned, not just connected: that's when it can be asked about.
  const learned = ws.sourceStates.some((s) => s.learnedAt !== null);
  const learning = ws.sourceStates.find((s) => s.status === "learning");
  const steps: SetupStep[] = [
    {
      key: "organization",
      label: "Create your organization",
      next: "create your organization",
      done: true,
      detail: ws.org.name,
    },
    learning && !learned
      ? {
          key: "data",
          label: "Connect your data",
          next: `Learning ${learning.name}…`,
          done: false,
          href: `/data/sources/${learning.id}`,
          actionLabel: "View progress",
          inProgress: true,
        }
      : {
          key: "data",
          label: "Connect your data",
          next: "connect your data",
          done: learned,
          detail: `${ws.sources} ${ws.sources === 1 ? "source" : "sources"}`,
          href: ws.sources > 0 ? "/data/sources" : "/data/sources/new",
          actionLabel: ws.sources > 0 ? "View sources" : "Connect",
        },
    // The starter pack: done once something's approved and nothing waits. A source with no pack (only the
    // sample has one so far) has nothing to approve, so the step doesn't hold setup back.
    {
      key: "starter-pack",
      label: "Approve your starter pack",
      next: "approve your starter pack",
      done: ws.definitions.verified > 0 && ws.definitions.proposed === 0,
      ...(ws.definitions.proposed > 0
        ? { href: "/knowledge/proposals", actionLabel: "Review", detail: `${ws.definitions.proposed} to review` }
        : {}),
      ...(ws.definitions.proposed + ws.definitions.verified === 0 ? { optional: true } : {}),
    },
    {
      key: "ask",
      label: "Ask your first question",
      next: "ask your first question",
      done: ws.asked,
      ...(learned && !ws.asked ? { href: "/ask/new", actionLabel: "Ask" } : {}),
    },
    {
      key: "invite",
      label: "Invite your team",
      next: "invite your team",
      done: ws.members > 1,
      optional: true,
      detail: `${ws.members} members`,
      ...(ws.members > 1 ? {} : { href: "/settings/members?invite", actionLabel: "Invite" }),
    },
  ];
  const required = steps.filter((s) => !s.optional);
  return {
    steps,
    done: required.filter((s) => s.done).length,
    total: required.length,
    next: required.find((s) => !s.done) ?? null,
  };
}

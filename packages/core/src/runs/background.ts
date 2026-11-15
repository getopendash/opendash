/** The runs that are background work: what they spend is counted by the background budget. */
export const BACKGROUND_TRIGGERS = ["insight", "routine", "proposal"] as const;
/** The agents whose runs are background work whoever asked: the Modeler drafts while nobody waits. */
export const BACKGROUND_PROFILES = ["modeler", "drafter", "curator"] as const;

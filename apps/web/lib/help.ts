/**
 * Where people get help on this instance: an address to write to, the docs, and a status page. Each comes from the
 * environment (OPENDASH_SUPPORT_EMAIL, OPENDASH_DOCS_URL, OPENDASH_STATUS_URL) and is left out when unset or not what
 * it should be, so a self-host shows only what its operator runs. Shown in the auth screens' footer, the account
 * menu and the error pages; emails carry the support address too (`@opendash/email`).
 */
export interface HelpLink {
  id: "support" | "docs" | "status";
  label: string;
  href: string;
}

const EMAIL = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/;

function webUrl(value: string | undefined): string | null {
  const given = value?.trim();
  if (!given) return null;
  try {
    const url = new URL(given);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** The support address, or null when none is set (or what's set isn't an address). */
export function supportEmail(env: Record<string, string | undefined> = process.env): string | null {
  const given = env.OPENDASH_SUPPORT_EMAIL?.trim();
  return given && EMAIL.test(given) ? given : null;
}

export function helpLinks(env: Record<string, string | undefined> = process.env): HelpLink[] {
  const support = supportEmail(env);
  const docs = webUrl(env.OPENDASH_DOCS_URL);
  const status = webUrl(env.OPENDASH_STATUS_URL);
  return [
    ...(docs ? [{ id: "docs" as const, label: "Docs", href: docs }] : []),
    ...(support ? [{ id: "support" as const, label: "Contact support", href: `mailto:${support}` }] : []),
    ...(status ? [{ id: "status" as const, label: "Status", href: status }] : []),
  ];
}

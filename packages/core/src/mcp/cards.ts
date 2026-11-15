/**
 * The cards a conversation shows when the analyst can't go on without the person: connect a
 * service (sign in, or add a key), or allow one call of a tool that asks first. The run ends with one of these; the
 * person's answer starts the next run, which carries on. An allowed call is checked on the server against what the
 * card showed (`digest`), and used once.
 */
import { createHash } from "node:crypto";
import { canonical } from "./servers";

export type McpConnectCard = {
  kind: "mcp_connect";
  serverId: string;
  server: string;
  /** Where the server is (`mcp.atlassian.com`), for its mark; a card from before it was kept has none. */
  host?: string;
  auth: "oauth" | "apikey";
  /** Nothing connected yet, a sign-in to do again, or a different account to choose about. */
  state: "connect" | "reconnect" | "wrong_account";
  /** Whose account it is: the person's own, or (an admin connecting it) the one everyone uses. */
  scope: "personal" | "org";
  message: string | null;
};

export type McpConsentCard = {
  kind: "mcp_consent";
  serverId: string;
  server: string;
  /** Where the server is, for its mark; a card from before it was kept has none. */
  host?: string;
  tool: string;
  /** The tool asks first, or it changed since an admin reviewed it. */
  reason: "ask" | "changed";
  /** Exactly what would be sent, shown on the card. */
  arguments: Record<string, unknown>;
  digest: string;
  /**
   * The tool as it was listed and the account the call would have run as, when the card was shown (the executor's
   * consentBinding): the Allow counts only while both are still these. A card from before it was kept asks again.
   */
  binding?: string;
};

export type McpCardOutcome = McpConnectCard | McpConsentCard;

/** What the person said yes to: one tool, on one server, with these arguments. */
export const callDigest = (serverId: string, tool: string, args: Record<string, unknown>): string =>
  createHash("sha256").update(canonical({ serverId, tool, args }), "utf8").digest("hex");

/** The words a card's buttons send as the person's next message. */
export const ALLOW_ONCE = "Allow once";
export const NOT_NOW = "Not now";

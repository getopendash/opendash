/**
 * Chat SDK's state (subscriptions, locks, dedupe) in OpenDash's Postgres: the `chat` schema a migration
 * made, never created by the SDK itself (`autoCreateSchema: false`). No message text is kept there: Slack keeps the
 * messages.
 */
import { createPostgresState } from "@chat-adapter/state-pg";
import { chatStatePool } from "@opendash/db";
import type { StateAdapter } from "chat";

export function slackState(systemUrl: string): { state: StateAdapter; close: () => Promise<void> } {
  const pool = chatStatePool(systemUrl);
  return {
    state: createPostgresState({ client: pool, autoCreateSchema: false, keyPrefix: "opendash" }),
    close: () => pool.end(),
  };
}

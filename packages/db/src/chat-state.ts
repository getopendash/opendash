/**
 * The connection for Chat SDK's state: node-postgres, which @chat-adapter/state-pg takes, as opendash_system
 * with search_path = chat, the schema migration 0044 made and only that role reaches. Its tables hold subscriptions,
 * locks and dedupe keys, never message text (Slack keeps the messages).
 */
import pg from "pg";

export function chatStatePool(systemUrl: string): pg.Pool {
  return new pg.Pool({ connectionString: systemUrl, max: 4, options: "-c search_path=chat" });
}

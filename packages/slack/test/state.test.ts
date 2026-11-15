// Chat SDK's state on the migrated `chat` schema: the adapter connects as opendash_system without creating
// anything, finds every privilege it needs, and keeps subscriptions and locks there; the app role can't reach them.
import { freshDatabase, type TestDatabase } from "@opendash/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { slackState } from "../src";

let t: TestDatabase;
beforeAll(async () => {
  t = await freshDatabase();
}, 120_000);
afterAll(async () => {
  await t?.drop();
});

describe("Chat SDK's state", () => {
  it("runs on the schema the migration made, as the system role", async () => {
    const { state, close } = slackState(t.url("opendash_system"));
    try {
      await state.connect();
      await state.subscribe("slack:C1:1.2");
      expect(await state.isSubscribed("slack:C1:1.2")).toBe(true);
      const lock = await state.acquireLock("slack:C1:1.2", 5_000);
      expect(lock).not.toBeNull();
      const [row] = await t.owner<{ n: number }[]>`select count(*)::int as n from chat.chat_state_subscriptions`;
      expect(row?.n).toBe(1);
    } finally {
      await state.disconnect();
      await close();
    }
  });

  it("isn't reachable as the app role", async () => {
    const { state, close } = slackState(t.url("opendash_app"));
    try {
      await expect(state.connect()).rejects.toThrow();
    } finally {
      await close();
    }
  });
});

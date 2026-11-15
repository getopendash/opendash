// Signing out forgets what the tab kept for that person and loads the next page afresh; when signing out fails,
// nothing is forgotten, the page stays, and they're told: they're still signed in.
import { beforeEach, describe, expect, it, vi } from "vitest";

const signOut = vi.hoisted(() => vi.fn());
const danger = vi.hoisted(() => vi.fn());
vi.mock("@opendash/auth/client", () => ({ authClient: { signOut } }));
vi.mock("@heroui/react", () => ({ toast: { danger } }));

const { signOutTo } = await import("../lib/sign-out");

const kept = new Map<string, string>();
const storage = {
  getItem: (k: string) => kept.get(k) ?? null,
  setItem: (k: string, v: string) => void kept.set(k, v),
  removeItem: (k: string) => void kept.delete(k),
};
const assign = vi.fn();
vi.stubGlobal(
  "sessionStorage",
  new Proxy(storage, {
    ownKeys: () => [...kept.keys()],
    getOwnPropertyDescriptor: (_, k) =>
      kept.has(String(k)) ? { enumerable: true, configurable: true, value: kept.get(String(k)) } : undefined,
  }),
);
vi.stubGlobal("window", { location: { assign } });

beforeEach(() => {
  kept.clear();
  kept.set("opendash.panel", "{}");
  kept.set("opendash.panel.org-1", "{}");
  kept.set("opendash.link-request", "{}");
  kept.set("opendash.sidebar", "open");
  signOut.mockReset();
  danger.mockReset();
  assign.mockReset();
});

describe("signing out", () => {
  it("forgets the person's panel and sign-in link, keeps the tab's own settings, and loads the page afresh", async () => {
    signOut.mockResolvedValue({ data: { success: true }, error: null });
    expect(await signOutTo("/sign-in")).toBe(true);
    expect([...kept.keys()]).toEqual(["opendash.sidebar"]);
    expect(assign).toHaveBeenCalledWith("/sign-in");
  });

  it("stays, forgetting nothing, and says so when signing out fails or can't be reached", async () => {
    for (const failure of [
      () => signOut.mockResolvedValue({ data: null, error: { status: 500 } }),
      () => signOut.mockRejectedValue(new TypeError("fetch failed")),
    ]) {
      failure();
      expect(await signOutTo("/sign-in")).toBe(false);
      expect(kept.size).toBe(4);
      expect(assign).not.toHaveBeenCalled();
    }
    expect(danger).toHaveBeenCalledTimes(2);
  });
});

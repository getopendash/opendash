// Two sets of server actions that take whatever a browser sends, with the session, queue and Better Auth stood in.
// Connecting a source: only owners and admins, the settings checked before anything is queued, a password only
// as text, write access accepted only by an explicit yes, and a check only by its id. The first password and an
// invitation: a short password never reaches Better Auth; an invitation joined goes home, one that can't be
// goes back to it; declining declines.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const session = vi.hoisted(() => ({ role: "admin" }));
const core = vi.hoisted(() => ({
  requestConnectionTest: vi.fn(async () => "0190a000-0000-7000-8000-0000000000aa"),
  connectFromTest: vi.fn(async () => "0190a000-0000-7000-8000-0000000000bb"),
}));
const api = vi.hoisted(() => ({
  setPassword: vi.fn(async () => ({})),
  acceptInvitation: vi.fn(async () => ({})),
  rejectInvitation: vi.fn(async () => ({})),
}));
class Redirect extends Error {
  constructor(readonly to: string) {
    super(`redirect ${to}`);
  }
}

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Redirect(to);
  },
}));
vi.mock("@/lib/auth", () => ({
  requireTenant: async () => ({ role: session.role, user: { id: "u-maya" }, ctx: { orgId: "org-acme" } }),
  getAuth: () => ({ api }),
}));
vi.mock("@/lib/sources", () => ({
  canManageSources: (role: string) => role === "owner" || role === "admin",
  queue: async () => ({}),
  secretStore: () => ({}),
}));
vi.mock("@opendash/core", async (actual) => ({ ...(await actual<object>()), ...core }));
vi.mock("@opendash/db", async (actual) => ({
  ...(await actual<object>()),
  withTenant: async (_ctx: unknown, fn: (tx: unknown) => Promise<unknown>) => fn({}),
}));

const sources = await import("../app/(app)/data/sources/new/actions");
const auth = await import("../app/(auth)/actions");

const settings = {
  dialect: "postgres" as const,
  host: "db.acme.test",
  port: "5432",
  database: "analytics",
  user: "reader",
  password: "s3cret-pass",
  sslMode: "require",
};
const redirectOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return null;
  } catch (error) {
    if (error instanceof Redirect) return error.to;
    throw error;
  }
};
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

beforeEach(() => {
  vi.clearAllMocks();
  session.role = "admin";
});

describe("connecting a source", () => {
  it("is for owners and admins: anyone else is refused before anything is checked or queued", async () => {
    for (const role of ["member", "viewer"]) {
      session.role = role;
      expect(await sources.startConnectionTest(settings)).toEqual({
        ok: false,
        message: "Only owners and admins can connect data sources.",
      });
      expect(
        await sources.connectSource({ testId: "0190a000-0000-7000-8000-0000000000aa", acceptWriteAccess: true }),
      ).toEqual({ message: "Only owners and admins can connect data sources." });
    }
    expect(core.requestConnectionTest).not.toHaveBeenCalled();
    expect(core.connectFromTest).not.toHaveBeenCalled();
  });

  it("checks the settings first, and takes a password only as text", async () => {
    const bad = await sources.startConnectionTest({ ...settings, host: "", port: "not a port" });
    expect(bad.ok).toBe(false);
    expect(bad.ok ? null : bad.errors).toMatchObject({ host: expect.any(String), port: expect.any(String) });
    expect(core.requestConnectionTest).not.toHaveBeenCalled();
    await sources.startConnectionTest({ ...settings, password: { toString: () => "x" } as never });
    expect(core.requestConnectionTest).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { orgId: "org-acme", userId: "u-maya" },
      expect.objectContaining({ dialect: "postgres", password: "" }),
    );
  });

  it("accepts write access only when it's a plain yes, and a check only by its id", async () => {
    expect(await sources.connectSource({ testId: "test-1", acceptWriteAccess: true })).toEqual({
      message: "That check doesn't exist.",
    });
    expect(
      await redirectOf(
        sources.connectSource({ testId: "0190a000-0000-7000-8000-0000000000aa", acceptWriteAccess: "yes" as never }),
      ),
    ).toBe("/data/sources/0190a000-0000-7000-8000-0000000000bb");
    expect(core.connectFromTest).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { orgId: "org-acme", userId: "u-maya" },
      { testId: "0190a000-0000-7000-8000-0000000000aa", acceptWriteAccess: false },
    );
  });
});

describe("the first password and an invitation", () => {
  it("refuses a short password without asking Better Auth", async () => {
    expect(await auth.choosePassword({ error: null }, form({ password: "short" }))).toEqual({
      error: "Use at least 10 characters.",
    });
    expect(api.setPassword).not.toHaveBeenCalled();
  });

  it("joins the invitation it came from and goes home, or back to the invitation when it can't", async () => {
    expect(
      await redirectOf(auth.choosePassword({ error: null }, form({ password: "long enough pw", invitation: "inv-1" }))),
    ).toBe("/");
    expect(api.acceptInvitation).toHaveBeenCalledWith({
      body: { invitationId: "inv-1" },
      headers: expect.any(Headers),
    });
    api.acceptInvitation.mockRejectedValueOnce(new Error("gone"));
    const back = await redirectOf(
      auth.choosePassword({ error: null }, form({ password: "long enough pw", invitation: "inv-1" })),
    );
    expect(back).toContain("inv-1");
    expect(back).not.toBe("/");
  });

  it("says an expired sign-up page needs a new link, and declines when asked to", async () => {
    api.setPassword.mockRejectedValueOnce({ body: { code: "SESSION_EXPIRED" } });
    expect(await auth.choosePassword({ error: null }, form({ password: "long enough pw" }))).toEqual({
      error: "This page has expired. Request a new link to finish.",
      expired: true,
    });
    expect(
      await redirectOf(auth.respondToInvitation({ error: null }, form({ invitation: "inv-2", response: "decline" }))),
    ).toBe("/");
    expect(api.rejectInvitation).toHaveBeenCalledTimes(1);
    expect(api.acceptInvitation).not.toHaveBeenCalled();
  });
});

// Working in an App: a query's records get an owner, a status of its own, a follow-up day and a
// note, kept in OpenDash; read by whoever reads the App, refused for a status it hasn't or someone who isn't in the
// workspace, and only for a query that says it's worked in.
import { uuidv7 } from "@opendash/db";
import { withTenantOn } from "@opendash/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dashboards } from "../src";
import { member, verifiedSource } from "./helpers/checks";
import type { LearnedSource } from "./helpers/learned-source";

let s: LearnedSource;
let dashboardId = "";
let revision = "";
const NOW = new Date("2026-10-11T09:00:00Z");
const as = () => ({ orgId: s.orgId, userId: s.userId });
const tx = <T>(fn: Parameters<typeof withTenantOn<T>>[2]) => withTenantOn(s.t.app, as(), fn);

beforeAll(async () => {
  ({ s } = await verifiedSource(NOW));
  await member(s, s.userId, "maya@acme.example", "owner");
  dashboardId = await tx((t) => dashboards.createDashboard(t, as(), { title: "Renewals" }));
  const source = { connection: s.connectionId, dataset: "accounts" };
  const saved = await tx((t) =>
    dashboards.saveDraft(t, as(), dashboardId, {
      baseVersion: 0,
      definition: {
        version: 2,
        title: "Renewals",
        filters: {},
        queries: {
          q_list: {
            source,
            select: ["id", "name"],
            filters: {},
            key: "id",
            work: { statuses: ["To do", "Chasing", "Done"], tones: { Done: "good" } },
          },
        },
      },
    }),
  );
  if (!saved.ok) throw new Error(JSON.stringify(saved.problems));
  revision = saved.revision;
}, 300_000);

afterAll(async () => {
  await s?.close();
});

describe("working in a list", () => {
  const at = {
    get dashboardId() {
      return dashboardId;
    },
    get revision() {
      return revision;
    },
    section: "q_list",
  };

  it("keeps a record's owner, status, follow-up and note, changing only what's given", async () => {
    const set = (patch: Record<string, string | null>) =>
      tx((t) => dashboards.setWork(t, as(), { dashboardId, revision, section: "q_list", key: "42", ...patch }));
    await set({ ownerId: s.userId, status: "Chasing", followUp: "2026-11-20" });
    const after = await set({ note: "Called, waiting on legal." });
    expect(after).toMatchObject({
      key: "42",
      ownerId: s.userId,
      status: "Chasing",
      followUp: "2026-11-20",
      note: "Called, waiting on legal.",
      updatedBy: s.userId,
    });
    const read = await tx((t) =>
      dashboards.readWork(t, as(), { dashboardId, revision, section: "q_list", keys: ["42", "7"] }),
    );
    expect(read?.map((w) => w.key)).toEqual(["42"]);
    void at;
  });

  it("refuses a status the list hasn't, an owner from outside, and a list that isn't worked in", async () => {
    const problem = async (p: Promise<unknown>) => {
      try {
        await p;
        return "ok";
      } catch (e) {
        return e instanceof Error ? e.message : "other";
      }
    };
    expect(
      await problem(
        tx((t) => dashboards.setWork(t, as(), { dashboardId, revision, section: "q_list", key: "42", status: "Lost" })),
      ),
    ).toBe("Its statuses are To do, Chasing, Done.");
    expect(
      await problem(
        tx((t) =>
          dashboards.setWork(t, as(), { dashboardId, revision, section: "q_list", key: "42", ownerId: uuidv7() }),
        ),
      ),
    ).toBe("A record's owner is someone in this workspace.");
    expect(
      await problem(
        tx((t) =>
          dashboards.setWork(t, as(), { dashboardId, revision, section: "q_list", key: "42", followUp: "2026-02-30" }),
        ),
      ),
    ).toBe("A follow-up is a day, like 2026-11-20.");
    expect(
      await problem(
        tx((t) => dashboards.setWork(t, as(), { dashboardId, revision, section: "q_nope", key: "42", status: "Done" })),
      ),
    ).toBe("That isn't a list you can work in here.");
    // A write that changes nothing is refused, and keeps no record: it would leave no history, so the rate cap
    // (which counts history) would never see it.
    expect(
      await problem(tx((t) => dashboards.setWork(t, as(), { dashboardId, revision, section: "q_list", key: "91" }))),
    ).toBe("Say what changes: an owner, a status, a note or a follow-up.");
    const [kept] = await s.t.owner<{ n: number }[]>`
      select count(*)::int as n from app.dashboard_work where dashboard_id = ${dashboardId} and record_key = '91'`;
    expect(kept?.n).toBe(0);
  });

  it("keeps each change's history, newest first, with who made it", async () => {
    await tx((t) =>
      dashboards.setWork(t, as(), { dashboardId, revision, section: "q_list", key: "77", status: "To do" }),
    );
    await tx((t) =>
      dashboards.setWork(t, as(), {
        dashboardId,
        revision,
        section: "q_list",
        key: "77",
        status: "Chasing",
        note: "Call booked",
      }),
    );
    const history = await tx((t) =>
      dashboards.readWorkHistory(t, as(), { dashboardId, revision, section: "q_list", key: "77" }),
    );
    expect(history?.map((h) => [h.field, h.value, h.by])).toEqual([
      ["note", "Call booked", s.userId],
      ["status", "Chasing", s.userId],
      ["status", "To do", s.userId],
    ]);
  });

  it("is read, never changed, in a draft someone else saved last, until its viewer saves it themselves", async () => {
    const bob = uuidv7();
    await member(s, bob, "bob@acme.example");
    const asBob = { orgId: s.orgId, userId: bob };
    const bobTx = <T>(fn: Parameters<typeof withTenantOn<T>>[2]) => withTenantOn(s.t.app, asBob, fn);
    await tx((t) => dashboards.shareDashboard(t, as(), dashboardId, { userId: bob, role: "edit" }));
    const current = await tx((t) => dashboards.getDashboard(t, as(), dashboardId));
    const definition = { ...(current?.draft?.definition ?? {}), title: "Renewals by Bob" };
    const saved = await bobTx((t) => dashboards.saveDraft(t, asBob, dashboardId, { definition, baseVersion: 0 }));
    const his = saved.ok ? saved.revision : "";
    const set = (who: typeof asBob, run: typeof bobTx, rev: string) =>
      run((t) =>
        dashboards.setWork(t, who, { dashboardId, revision: rev, section: "q_list", key: "42", status: "Done" }),
      );
    // Bob's code: Maya reads the list's work in it, but nothing it sends changes a record.
    await expect(set(as(), tx, his)).rejects.toThrow(dashboards.ACTIONS_OFF);
    expect(
      await tx((t) => dashboards.readWork(t, as(), { dashboardId, revision: his, section: "q_list", keys: ["42"] })),
    ).toHaveLength(1);
    // He saved it: his changes go through. Saved by Maya again, hers do.
    expect(await set(asBob, bobTx, his)).toMatchObject({ status: "Done", updatedBy: bob });
    const draftAt = (await tx((t) => dashboards.workingCopy(t, as(), dashboardId)))?.draftAt ?? null;
    const mine = await tx((t) =>
      dashboards.saveDraft(t, as(), dashboardId, {
        definition: { ...definition, title: "Renewals" },
        baseVersion: 0,
        baseDraftAt: draftAt,
      }),
    );
    expect(await set(as(), tx, mine.ok ? mine.revision : "")).toMatchObject({ status: "Done", updatedBy: s.userId });
  });
});

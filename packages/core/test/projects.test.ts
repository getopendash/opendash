// Projects: a project's people and roles, who reads what's in it, moving
// things in and out, and what removing someone or deleting the project leaves behind.
import { sql, uuidv7 } from "@opendash/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  checkDefinitions,
  createFolder,
  createProject,
  dashboardReadableBy,
  deleteFolder,
  deleteProject,
  demoPack,
  getThread,
  installDefinitions,
  keyTableChoices,
  listDefinitions,
  listFolders,
  listProjects,
  listThreads,
  moveToFolder,
  moveToProject,
  ProjectNotFound,
  ProjectRefused,
  projectKeyTables,
  projectPeople,
  removeProjectPerson,
  renameFolder,
  setKeyTables,
  setProjectPerson,
  shareThread,
  submitQuestion,
  updateProject,
  verifyDefinitions,
} from "../src";
import { type LearnedSource, learnedSource } from "./helpers/learned-source";

let s: LearnedSource;
// Alice manages the project; Bob joins it; Carol is in the organization only; Dana is an admin; Vic a viewer.
let alice = "";
const bob = uuidv7();
const carol = uuidv7();
const dana = uuidv7();
const vic = uuidv7();
const actor = (userId: string, orgRole = "member") => ({ orgId: s.orgId, userId, orgRole });
const viewer = (userId: string) => ({ orgId: s.orgId, userId });
const deps = () => ({ withTenant: s.deps.withTenant, boss: null });

const refused = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (error) {
    if (error instanceof ProjectRefused) return error.message;
    if (error instanceof ProjectNotFound) return "not found";
    throw error;
  }
};
/** Asks as someone, in a project or not, then ends the run (no worker here). */
async function ask(userId: string, text: string, project?: string) {
  const r = await submitQuestion(deps(), {
    orgId: s.orgId,
    userId,
    connectionId: s.connectionId,
    text,
    channel: "web",
    model: "test-model",
    ...(project ? { project: { id: project, orgRole: "member" } } : {}),
  });
  await s.t.owner`update app.run set status = 'failed', error = 'test', finished_at = now() where id = ${r.runId}`;
  return r.threadId;
}
const reads = async (userId: string, threadId: string) => (await getThread(deps(), viewer(userId), threadId)) !== null;

let board = "";
let shared = "";
let privateOne = "";

/** Makes someone a member of the organization, as Better Auth does: a project's people are its members. */
async function joins(userId: string, role = "member"): Promise<void> {
  await s.t.auth.client`insert into auth.user (id, name, email, email_verified)
    values (${userId}, 'Someone', ${`someone-${userId}@acme.test`}, true) on conflict do nothing`;
  await s.t.auth.client`insert into auth.member (id, organization_id, user_id, role, created_at)
    values (${uuidv7()}, ${s.orgId}, ${userId}, ${role}, now())`;
}

beforeAll(async () => {
  s = await learnedSource();
  alice = s.userId;
  for (const [userId, role] of [
    [bob, "member"],
    [carol, "member"],
    [dana, "admin"],
    [vic, "viewer"],
  ] as const) {
    await joins(userId, role);
  }
}, 300_000);

afterAll(async () => {
  await s?.close();
});

describe("projects", () => {
  it("are made by members, who manage them; the organization's viewers can't", async () => {
    expect(await refused(s.tenant((tx) => createProject(tx, actor(vic, "viewer"), { name: "Nope" })))).toMatch(
      /Viewers can't create projects/,
    );
    const p = await s.tenant((tx) => createProject(tx, actor(alice), { name: "Board pack" }));
    board = p.id;
    expect(p).toMatchObject({
      name: "Board pack",
      slug: "board-pack",
      visibility: "private",
      role: "manager",
      people: 1,
    });
    // The same name again gets its own slug.
    const again = await s.tenant((tx) => createProject(tx, actor(alice), { name: "Board  pack!" }));
    expect(again.slug).toBe("board-pack-2");
    // Two at the same moment: each gets its own slug.
    const both = await Promise.all([
      s.tenant((tx) => createProject(tx, actor(alice), { name: "Pricing" })),
      s.tenant((tx) => createProject(tx, actor(alice), { name: "Pricing" })),
    ]);
    expect(both.map((p) => p.slug).sort()).toEqual(["pricing", "pricing-2"]);
    for (const p of [again, ...both]) await s.tenant((tx) => deleteProject(tx, actor(alice), p.id));
  });

  it("show what's shared with them to their people only; private stays private", async () => {
    await s.tenant((tx) =>
      setProjectPerson(tx, actor(alice), board, { userId: bob, orgRole: "member", role: "editor" }),
    );
    // Started from the project: shared with its people from the start.
    shared = await ask(alice, "MRR for the board?", board);
    const t = await getThread(deps(), viewer(alice), shared);
    expect(t?.thread).toMatchObject({ visibility: "project", projectId: board });
    // Moved in but not shared: still only Alice's.
    privateOne = await ask(alice, "My draft numbers");
    await s.tenant((tx) => moveToProject(tx, actor(alice), { kind: "thread", id: privateOne }, board));
    expect(await reads(bob, shared)).toBe(true);
    expect(await reads(bob, privateOne)).toBe(false);
    expect(await reads(carol, shared)).toBe(false);
    expect((await listThreads(deps(), viewer(bob))).map((x) => x.id)).toEqual([shared]);
    // Carol doesn't see the project at all.
    expect(await s.tenant((tx) => listProjects(tx, actor(carol)))).toEqual([]);
    const forBob = await s.tenant((tx) => listProjects(tx, actor(bob)));
    expect(forBob).toMatchObject([{ id: board, role: "editor", people: 2, conversations: 1 }]);
    const forAlice = await s.tenant((tx) => listProjects(tx, actor(alice)));
    expect(forAlice[0]?.conversations).toBe(2);
  });

  it("let only editors and managers add to them, and only owners move their own things", async () => {
    await s.tenant((tx) =>
      setProjectPerson(tx, actor(alice), board, { userId: carol, orgRole: "member", role: "viewer" }),
    );
    const carols = await ask(carol, "Carol's question");
    expect(
      await refused(s.tenant((tx) => moveToProject(tx, actor(carol), { kind: "thread", id: carols }, board))),
    ).toMatch(/editors and managers/);
    expect(await refused(ask(carol, "In the project?", board))).toMatch(/editors and managers/);
    expect(
      await refused(s.tenant((tx) => moveToProject(tx, actor(bob), { kind: "thread", id: shared }, null))),
    ).toMatch(/Only its owner/);
    // A viewer reads what's shared with the project.
    expect(await reads(carol, shared)).toBe(true);
    await s.tenant((tx) => removeProjectPerson(tx, actor(alice), board, carol));
  });

  it("open to the organization: everyone reads what's shared with it, only its people add", async () => {
    await s.tenant((tx) => updateProject(tx, actor(alice), board, { visibility: "org" }));
    expect(await reads(carol, shared)).toBe(true);
    expect(await s.tenant((tx) => listProjects(tx, actor(carol)))).toMatchObject([{ id: board, role: null }]);
    expect(await refused(ask(carol, "Can I?", board))).toMatch(/editors and managers/);
    expect(await refused(s.tenant((tx) => updateProject(tx, actor(carol), board, { name: "Mine" })))).toMatch(
      /Only the project's managers/,
    );
    await s.tenant((tx) => updateProject(tx, actor(alice), board, { visibility: "private" }));
    expect(await reads(carol, shared)).toBe(false);
  });

  it("are seen and managed by admins, who read inside only once they're in", async () => {
    expect(await s.tenant((tx) => listProjects(tx, actor(dana, "admin")))).toMatchObject([{ id: board, role: null }]);
    expect(await reads(dana, shared)).toBe(false);
    await s.tenant((tx) =>
      setProjectPerson(tx, actor(dana, "admin"), board, { userId: dana, orgRole: "admin", role: "viewer" }),
    );
    expect(await reads(dana, shared)).toBe(true);
    await s.tenant((tx) => removeProjectPerson(tx, actor(dana, "admin"), board, dana));
  });

  it("keep a manager, and the organization's viewers only as viewers", async () => {
    expect(
      await refused(
        s.tenant((tx) =>
          setProjectPerson(tx, actor(alice), board, { userId: alice, orgRole: "member", role: "editor" }),
        ),
      ),
    ).toMatch(/needs a manager/);
    expect(await refused(s.tenant((tx) => removeProjectPerson(tx, actor(alice), board, alice)))).toMatch(
      /needs a manager/,
    );
    expect(
      await refused(
        s.tenant((tx) => setProjectPerson(tx, actor(alice), board, { userId: vic, orgRole: "viewer", role: "editor" })),
      ),
    ).toMatch(/only be viewers/);
    expect(
      await refused(
        s.tenant((tx) => setProjectPerson(tx, actor(bob), board, { userId: carol, orgRole: "member", role: "viewer" })),
      ),
    ).toMatch(/Only the project's managers add people/);
    const people = await s.tenant((tx) => projectPeople(tx, actor(alice), board));
    expect(people.map((p) => [p.userId, p.role])).toEqual([
      [alice, "manager"],
      [bob, "editor"],
    ]);
  });

  it("count an organization viewer as a viewer, whatever role they were given before", async () => {
    // Bob is an editor; then his organization role becomes viewer.
    const asViewer = actor(bob, "viewer");
    expect((await s.tenant((tx) => listProjects(tx, asViewer)))[0]?.role).toBe("viewer");
    const draft = await ask(bob, "Bob's draft");
    expect(await refused(s.tenant((tx) => moveToProject(tx, asViewer, { kind: "thread", id: draft }, board)))).toMatch(
      /editors and managers/,
    );
    const asking = submitQuestion(deps(), {
      orgId: s.orgId,
      userId: bob,
      connectionId: s.connectionId,
      text: "In the project, as a viewer?",
      channel: "web",
      model: "test-model",
      project: { id: board, orgRole: "viewer" },
    });
    expect(await refused(asking)).toMatch(/editors and managers/);
  });

  it("take a dashboard its owner moves in, shared with their people like a conversation", async () => {
    const dashboard = uuidv7();
    await s.t.owner`insert into app.dashboard (org_id, id, title, owner_id)
      values (${s.orgId}, ${dashboard}, 'Board MRR', ${alice})`;
    const readsDashboard = async (userId: string) =>
      (
        await s.tenant((tx) =>
          tx.execute(sql`select 1 from app.dashboard d where d.id = ${dashboard} and ${dashboardReadableBy(userId)}`),
        )
      ).length > 0;
    expect(
      await refused(s.tenant((tx) => moveToProject(tx, actor(bob), { kind: "dashboard", id: dashboard }, board))),
    ).toMatch(/Only its owner/);
    await s.tenant((tx) =>
      moveToProject(tx, actor(alice), { kind: "dashboard", id: dashboard }, board, { share: true }),
    );
    expect(await readsDashboard(bob)).toBe(true);
    expect(await readsDashboard(carol)).toBe(false);
    expect(await s.tenant((tx) => listProjects(tx, actor(bob)))).toMatchObject([{ id: board, dashboards: 1 }]);
  });

  it("stop showing what's shared with them to someone removed, who keeps their own things", async () => {
    const bobs = await ask(bob, "Bob's pricing question", board);
    await s.tenant((tx) => removeProjectPerson(tx, actor(alice), board, bob));
    expect(await reads(bob, shared)).toBe(false);
    expect(await reads(bob, bobs)).toBe(true);
    // Still in the project, shared with its people.
    expect(await reads(alice, bobs)).toBe(true);
    await s.tenant((tx) =>
      setProjectPerson(tx, actor(alice), board, { userId: bob, orgRole: "member", role: "editor" }),
    );
  });

  it("move a project-shared thing out as private, and share with the project only when asked", async () => {
    const t = await ask(alice, "To move around", board);
    await s.tenant((tx) => moveToProject(tx, actor(alice), { kind: "thread", id: t }, null));
    expect((await getThread(deps(), viewer(alice), t))?.thread).toMatchObject({
      visibility: "private",
      projectId: null,
    });
    await s.tenant((tx) => moveToProject(tx, actor(alice), { kind: "thread", id: t }, board, { share: true }));
    expect(await reads(bob, t)).toBe(true);
    // Sharing with the project needs a project.
    const loose = await ask(alice, "Not in a project");
    expect(await shareThread(deps(), viewer(alice), loose, "project")).toBe(false);
    await expect(s.t.owner`update app.thread set visibility = 'project' where id = ${loose}`).rejects.toThrow(
      /thread_project_visibility_check/,
    );
  });

  it("have folders, one level deep, made by editors and holding their owners' things", async () => {
    const p = await s.tenant((tx) => createProject(tx, actor(alice), { name: "Close" }));
    await s.tenant((tx) =>
      setProjectPerson(tx, actor(alice), p.id, { userId: bob, orgRole: "member", role: "editor" }),
    );
    await s.tenant((tx) =>
      setProjectPerson(tx, actor(alice), p.id, { userId: carol, orgRole: "member", role: "viewer" }),
    );
    const f = await s.tenant((tx) => createFolder(tx, actor(bob), p.id, "Monthly close"));
    expect(await refused(s.tenant((tx) => createFolder(tx, actor(carol), p.id, "Mine")))).toMatch(
      /editors and managers add to it/,
    );
    expect(await refused(s.tenant((tx) => createFolder(tx, actor(alice), p.id, "monthly  close!")))).toBe(
      "This project has a folder by that name already.",
    );
    // A folder isn't a project.
    expect((await s.tenant((tx) => listProjects(tx, actor(alice)))).map((x) => x.id)).not.toContain(f.id);
    const t = await ask(alice, "Close numbers?", p.id);
    const loose = await ask(alice, "Not in any project?");
    expect(await refused(s.tenant((tx) => moveToFolder(tx, actor(bob), { kind: "thread", id: t }, f.id)))).toBe(
      "Only its owner moves it.",
    );
    expect(await refused(s.tenant((tx) => moveToFolder(tx, actor(alice), { kind: "thread", id: loose }, f.id)))).toBe(
      "It isn't in a project, so it can't go in a folder.",
    );
    await s.tenant((tx) => moveToFolder(tx, actor(alice), { kind: "thread", id: t }, f.id));
    expect((await getThread(deps(), viewer(alice), t))?.thread.folderId).toBe(f.id);
    // Its project's viewer reads it there.
    expect(await s.tenant((tx) => listFolders(tx, actor(carol), p.id))).toEqual([
      { id: f.id, name: "Monthly close", conversations: 1, dashboards: 0 },
    ]);
    // Another project's folder is refused, here and by the database.
    const other = await s.tenant((tx) => createProject(tx, actor(alice), { name: "Elsewhere" }));
    const g = await s.tenant((tx) => createFolder(tx, actor(alice), other.id, "Drafts"));
    expect(await refused(s.tenant((tx) => moveToFolder(tx, actor(alice), { kind: "thread", id: t }, g.id)))).toBe(
      "not found",
    );
    await expect(s.t.owner`update app.thread set folder_id = ${g.id} where id = ${t}`).rejects.toThrow(
      /thread_folder_fk/,
    );
    await s.tenant((tx) => renameFolder(tx, actor(bob), f.id, "Close"));
    expect((await s.tenant((tx) => listFolders(tx, actor(alice), p.id)))[0]?.name).toBe("Close");
    // Moved to another project, it leaves its folder; a folder deleted leaves its things in the project.
    await s.tenant((tx) => moveToProject(tx, actor(alice), { kind: "thread", id: t }, other.id));
    expect((await getThread(deps(), viewer(alice), t))?.thread).toMatchObject({ projectId: other.id, folderId: null });
    await s.tenant((tx) => moveToFolder(tx, actor(alice), { kind: "thread", id: t }, g.id));
    await s.tenant((tx) => deleteFolder(tx, actor(alice), g.id));
    expect((await getThread(deps(), viewer(alice), t))?.thread).toMatchObject({ projectId: other.id, folderId: null });
    expect(await s.tenant((tx) => listFolders(tx, actor(alice), other.id))).toEqual([]);
    // A project deleted takes its folders with it.
    for (const x of [p, other]) await s.tenant((tx) => deleteProject(tx, actor(alice), x.id));
    const [left] = await s.t.owner<{ n: number }[]>`
      select count(*)::int as n from app.project where id = ${f.id} and deleted_at is null`;
    expect(left?.n).toBe(0);
  });

  it("have key tables, chosen by managers from a source's catalog, each with its verified dataset or none", async () => {
    const p = await s.tenant((tx) => createProject(tx, actor(alice), { name: "Keys" }));
    await s.tenant((tx) =>
      setProjectPerson(tx, actor(alice), p.id, { userId: bob, orgRole: "member", role: "editor" }),
    );
    // The demo pack, checked and verified: each dataset records the tables it reads.
    const ctx = { orgId: s.orgId, userId: alice };
    await s.tenant((tx) =>
      installDefinitions(tx, ctx, s.connectionId, demoPack("postgres"), { status: "proposed", source: "pack" }),
    );
    await checkDefinitions(s.deps, { orgId: s.orgId, connectionId: s.connectionId });
    const defs = await s.tenant((tx) => listDefinitions(tx, s.orgId, { connectionId: s.connectionId }));
    await s.tenant((tx) =>
      verifyDefinitions(
        tx,
        ctx,
        defs.map((d) => d.id),
      ),
    );
    const choices = await s.tenant((tx) => keyTableChoices(tx, actor(bob), p.id, s.connectionId));
    const items = choices.find((c) => c.table === "public.subscription_items");
    expect(items).toMatchObject({ rows: expect.any(Number), covered: { id: expect.any(String) } });
    const uncovered = choices.find((c) => !c.covered);
    expect(uncovered).toBeDefined();
    const pick = [
      { connectionId: s.connectionId, table: "public.subscription_items" },
      { connectionId: s.connectionId, table: uncovered?.table as string },
    ];
    expect(await refused(s.tenant((tx) => setKeyTables(tx, actor(bob), p.id, pick)))).toBe(
      "Only the project's managers choose its key tables.",
    );
    expect(
      await refused(
        s.tenant((tx) =>
          setKeyTables(tx, actor(alice), p.id, [{ connectionId: s.connectionId, table: "public.nope" }]),
        ),
      ),
    ).toBe("public.nope isn't a table in that source's catalog.");
    // Chosen once each, in order; anyone who can see the project reads them.
    await s.tenant((tx) => setKeyTables(tx, actor(alice), p.id, [...pick, pick[0] as (typeof pick)[number]]));
    const keys = await s.tenant((tx) => projectKeyTables(tx, actor(bob), p.id));
    expect(keys.map((k) => [k.table, k.present, Boolean(k.covered)])).toEqual([
      ["public.subscription_items", true, true],
      [uncovered?.table, true, false],
    ]);
    expect(await refused(s.tenant((tx) => projectKeyTables(tx, actor(carol), p.id)))).toBe("not found");
    await s.tenant((tx) => deleteProject(tx, actor(alice), p.id));
  });

  it("deleted: everything moves out with its owner, and what was shared with it becomes private", async () => {
    const orgShared = await ask(alice, "For everyone", board);
    await shareThread(deps(), viewer(alice), orgShared, "org");
    expect(await refused(s.tenant((tx) => deleteProject(tx, actor(bob), board)))).toMatch(
      /Only the project's managers delete/,
    );
    await s.tenant((tx) => deleteProject(tx, actor(alice), board));
    expect(await s.tenant((tx) => listProjects(tx, actor(alice)))).toEqual([]);
    expect((await getThread(deps(), viewer(alice), shared))?.thread).toMatchObject({
      visibility: "private",
      projectId: null,
    });
    expect(await reads(bob, shared)).toBe(false);
    // Shared with the organization stays so: nothing is shown to more people, nor fewer than chose.
    expect((await getThread(deps(), viewer(carol), orgShared))?.thread.visibility).toBe("org");
    const [left] = await s.t.owner<{ n: number }[]>`
      select count(*)::int as n from app.project_member where project_id = ${board}`;
    expect(left?.n).toBe(0);
  });
});

describe("a project's people", () => {
  it("lose their role with their membership, and someone invited back starts with none", async () => {
    const eve = uuidv7();
    await joins(eve);
    const plans = await s.tenant((tx) => createProject(tx, actor(alice), { name: "Plans" }));
    await s.tenant((tx) =>
      setProjectPerson(tx, actor(alice), plans.id, { userId: eve, orgRole: "member", role: "manager" }),
    );
    const roles = async () =>
      (
        await s.t.owner<{ n: number }[]>`
          select count(*)::int as n from app.project_member where project_id = ${plans.id} and principal_id = ${eve}`
      )[0]?.n;
    expect(await roles()).toBe(1);
    await s.t.auth.client`delete from auth.member where organization_id = ${s.orgId} and user_id = ${eve}`;
    expect(await roles()).toBe(0);
    await joins(eve);
    expect(await roles()).toBe(0);
    await s.tenant((tx) => deleteProject(tx, actor(alice), plans.id));
  });
});

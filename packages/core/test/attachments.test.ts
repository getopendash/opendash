// Conversation context: what a person can attach to a question, what's kept on it, and what each run of its
// conversation is given.
import { uuidv7 } from "@opendash/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Attachment,
  AttachmentProblem,
  attachable,
  conversationAttachments,
  demoPack,
  getThread,
  installDefinitions,
  saveGuide,
  submitQuestion,
} from "../src";
import { type LearnedSource, learnedSource } from "./helpers/learned-source";

let s: LearnedSource;
let guide = "";
let mrr = "";

const as = (userId: string) => ({ orgId: s.orgId, userId });
// Asks, then ends the run (no worker here), so the conversation takes its next question.
const ask = async (text: string, attachments: Attachment[], threadId?: string) => {
  const r = await submitQuestion(
    { withTenant: s.deps.withTenant, boss: null },
    {
      orgId: s.orgId,
      userId: s.userId,
      connectionId: s.connectionId,
      ...(threadId ? { threadId } : {}),
      text,
      channel: "web",
      model: "test-model",
      attachments,
    },
  );
  await s.t.owner`update app.run set status = 'failed', error = 'test', finished_at = now() where id = ${r.runId}`;
  return r;
};
const refused = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (error) {
    if (error instanceof AttachmentProblem) return error.message;
    throw error;
  }
};

beforeAll(async () => {
  s = await learnedSource();
  await s.tenant((tx) =>
    installDefinitions(tx, as(s.userId), s.connectionId, demoPack("postgres"), { status: "verified", source: "pack" }),
  );
  guide = (
    await s.tenant((tx) =>
      saveGuide(tx, as(s.userId), {
        title: "Fiscal year starts in February",
        body: "Our fiscal year starts on February 1.",
        connectionId: s.connectionId,
      }),
    )
  ).id;
  await s.t.owner`update app.context_item set released_version = 1, status = 'verified' where id = ${guide}`;
  const [m] = await s.t.owner<{ id: string }[]>`
    select id from app.context_item where org_id = ${s.orgId} and kind = 'metric' and slug = 'mrr'`;
  mrr = m?.id as string;
}, 300_000);

afterAll(async () => {
  await s?.close();
});

describe("attaching", () => {
  it("offers released metrics and guides, on this source", async () => {
    const all = await s.tenant((tx) => attachable(tx, as(s.userId), s.connectionId));
    expect(all.find((a) => a.id === mrr)).toEqual({
      kind: "metric",
      id: mrr,
      title: "Monthly recurring revenue",
      meta: "Verified metric",
    });
    expect(all.find((a) => a.id === guide)?.meta).toBe("Guide");
    const narrowed = await s.tenant((tx) => attachable(tx, as(s.userId), s.connectionId, "fiscal"));
    expect(narrowed.map((a) => a.id)).toEqual([guide]);
  });

  it("keeps what was attached on the question, and refuses what isn't available or is too much", async () => {
    const { threadId } = await ask("How is revenue doing?", [
      { kind: "metric", id: mrr },
      { kind: "guide", id: guide },
      { kind: "metric", id: mrr },
    ]);
    const view = await getThread(s.deps, as(s.userId), threadId);
    expect(view?.turns[0]?.message.attachments).toEqual([
      { kind: "metric", id: mrr, title: "Monthly recurring revenue" },
      { kind: "guide", id: guide, title: "Fiscal year starts in February" },
    ]);
    const unavailable =
      "Something you attached isn't available here: it was removed, isn't shared with you, or is about another source.";
    expect(await refused(ask("And this?", [{ kind: "metric", id: guide }]))).toBe(unavailable);
    expect(await refused(ask("And this?", [{ kind: "guide", id: "nope" }]))).toBe(unavailable);
    // A teammate's own guide isn't shared with the asker.
    const theirs = uuidv7();
    const teammate = uuidv7();
    await s.t.owner`
      insert into app.context_item (org_id, id, kind, scope, scope_id, connection_id, path, slug, title, status,
        current_version, released_version, owner_id)
      values (${s.orgId}, ${theirs}, 'guide', 'personal', ${teammate}, ${s.connectionId}, '/guides/renewals.md',
        'renewals', 'Renewals count from the invoice date', 'verified', 1, 1, ${teammate})`;
    await s.t.owner`
      insert into app.context_item_version (org_id, item_id, version, body, body_hash, spec, source)
      values (${s.orgId}, ${theirs}, 1, 'Renewals count from the invoice date.', 'h', '{}'::jsonb, 'user')`;
    expect(await refused(ask("And this?", [{ kind: "guide", id: theirs }]))).toBe(unavailable);
    const six = Array.from({ length: 6 }, () => ({ kind: "guide" as const, id: uuidv7() }));
    expect(await refused(ask("Too many?", six))).toBe("Attach up to 5 things to a question.");
    // A follow-up is checked against its conversation's source.
    expect(await refused(ask("Follow-up", [{ kind: "metric", id: mrr }], threadId))).toBe("ok");
  });
});

describe("a dashboard someone attached", () => {
  /** A dashboard with a published version, and (`draft`) its owner's draft. */
  const board = async (owner: string, title: string, visibility: string, draft?: string, connection?: string) => {
    const id = uuidv7();
    const def = (t: string) => ({
      version: 2,
      title: t,
      filters: {},
      queries: {
        q_n: { source: { connection: connection ?? s.connectionId, dataset: "accounts" }, measures: { n: ["count"] } },
      },
    });
    await s.t.owner`
      insert into app.dashboard (org_id, id, title, owner_id, visibility, current_version)
      values (${s.orgId}, ${id}, ${title}, ${owner}, ${visibility}, 1)`;
    await s.t.owner`
      insert into app.dashboard_version (org_id, dashboard_id, version, definition, runtime_hash, revision)
      values (${s.orgId}, ${id}, 1, ${s.t.owner.json(def(title))}, 'r', ${`rev-${id}`})`;
    if (draft) {
      await s.t.owner`
        insert into app.dashboard_draft (org_id, dashboard_id, definition, base_version)
        values (${s.orgId}, ${id}, ${s.t.owner.json(def(draft))}, 1)`;
    }
    return id;
  };

  it("offers the dashboards the asker can open, gives each as they see it, and drops one no longer shared", async () => {
    const teammate = uuidv7();
    const mine = await board(s.userId, "Sign-up review", "private", "Sign-up review, renamed");
    const shared = await board(teammate, "Sign-up review for the team", "org");
    const hidden = await board(teammate, "Sign-up review, private", "private");
    // One of theirs on another source: not offered here; attached anyway (the panel beside it), and theirs to change
    // (the analyst checks each query's source against what its run can read when it saves).
    const elsewhere = await board(s.userId, "Sign-up review elsewhere", "private", undefined, uuidv7());
    const offered = await s.tenant((tx) => attachable(tx, as(s.userId), s.connectionId, "sign-up review"));
    expect(offered.filter((a) => a.kind === "dashboard")).toEqual([
      { kind: "dashboard", id: shared, title: "Sign-up review for the team", meta: "Dashboard · shared with you" },
      { kind: "dashboard", id: mine, title: "Sign-up review", meta: "Dashboard · yours" },
    ]);
    const unavailable =
      "Something you attached isn't available here: it was removed, isn't shared with you, or is about another source.";
    expect(await refused(ask("And this?", [{ kind: "dashboard", id: hidden }]))).toBe(unavailable);

    const { threadId } = await ask("Why did sign-ups drop?", [
      { kind: "dashboard", id: mine },
      { kind: "dashboard", id: shared },
      { kind: "dashboard", id: elsewhere },
    ]);
    const view = await getThread(s.deps, as(s.userId), threadId);
    expect(view?.turns[0]?.message.attachments).toEqual([
      { kind: "dashboard", id: mine, title: "Sign-up review" },
      { kind: "dashboard", id: shared, title: "Sign-up review for the team" },
      { kind: "dashboard", id: elsewhere, title: "Sign-up review elsewhere" },
    ]);
    const given = await s.tenant((tx) => conversationAttachments(tx, as(s.userId), threadId, s.connectionId));
    // Its owner is given their draft, and may change it from here; a teammate's is given as published, to read.
    expect(given.items).toMatchObject([
      {
        kind: "dashboard",
        id: mine,
        // Its title as published; the draft's rename is its owner's, given beside it.
        title: "Sign-up review",
        draftTitle: "Sign-up review, renamed",
        mine: true,
        shared: false,
        changeable: true,
        draft: true,
      },
      {
        kind: "dashboard",
        id: shared,
        title: "Sign-up review for the team",
        mine: false,
        shared: true,
        changeable: false,
        draft: false,
        version: 1,
      },
      { kind: "dashboard", id: elsewhere, mine: true, changeable: true },
    ]);
    expect(given.items[1]).toMatchObject({ definition: { title: "Sign-up review for the team" } });
    // Asked with the question this run answers: each is what was on screen when they asked.
    expect(given.items.map((a) => a.kind === "dashboard" && a.withQuestion)).toEqual([true, true, true]);
    // A later question asked without them: they're the conversation's, no longer what this question is about.
    await s.t.owner`
      insert into app.message (org_id, id, thread_id, seq, role, kind, author_id, text, status, content)
      select org_id, ${uuidv7()}, thread_id, seq + 1, role, kind, author_id, 'And last week?', 'complete', content
      from app.message where thread_id = ${threadId} and role = 'user' order by seq desc limit 1`;
    const later = await s.tenant((tx) => conversationAttachments(tx, as(s.userId), threadId, s.connectionId));
    expect(later.items.map((a) => a.kind === "dashboard" && a.withQuestion)).toEqual([false, false, false]);

    // Made private again: the conversation is told one thing it had is gone.
    await s.t.owner`update app.dashboard set visibility = 'private' where id = ${shared}`;
    const after = await s.tenant((tx) => conversationAttachments(tx, as(s.userId), threadId, s.connectionId));
    expect(after.items.map((a) => a.id)).toEqual([mine, elsewhere]);
    expect(after.missing).toBe(1);
  });
});

describe("a piece of an App its owner selected (select to edit)", () => {
  // Thirty lines, the 22nd the list row the person clicked.
  const QUEUE = Array.from({ length: 30 }, (_, i) =>
    i === 21 ? '      <li className="row">{t.subject}</li>' : `// line ${i + 1}`,
  ).join("\n");
  /** An App with no version yet, its owner's draft at `rev-<id>` with these files. */
  const app = async (owner: string) => {
    const id = uuidv7();
    await s.t.owner`
      insert into app.dashboard (org_id, id, title, owner_id, visibility, current_version)
      values (${s.orgId}, ${id}, 'Support queue', ${owner}, 'org', 0)`;
    await s.t.owner`
      insert into app.dashboard_draft (org_id, dashboard_id, definition, parts, revision, base_version)
      values (${s.orgId}, ${id}, ${s.t.owner.json({ version: 2, title: "Support queue", filters: {}, queries: {} })},
        ${s.t.owner.json({ "/App.tsx": "export default function App() {}", "/components/Queue.tsx": QUEUE })},
        ${`rev-${id}`}, 0)`;
    return id;
  };
  const piece = (dashboardId: string, over: Record<string, unknown> = {}): Attachment => ({
    kind: "app_element",
    id: uuidv7(),
    dashboardId,
    revision: `rev-${dashboardId}`,
    file: "/components/Queue.tsx",
    line: 22,
    column: 7,
    tag: "li",
    text: "  #4656\n   urgent ",
    ...over,
  });

  it("is kept with the lines around it read from the App's own file, and given to the runs after it", async () => {
    const mine = await app(s.userId);
    // The page's own claims about the code are never taken: the lines are read from the stored file.
    const pick = piece(mine, { snippet: "forged", fileHash: "forged", name: "forged" });
    // The same piece selected twice is one selection.
    const { threadId } = await ask("Make this bold", [pick, piece(mine)]);
    const label = "‘#4656 urgent’ in Queue";
    const view = await getThread(s.deps, as(s.userId), threadId);
    expect(view?.turns[0]?.message.attachments).toEqual([{ kind: "app_element", id: pick.id, title: label }]);
    // Another reader of the shared conversation sees that something was selected, not what (the App's draft is its
    // owner's).
    await s.t.owner`update app.thread set visibility = 'org' where id = ${threadId}`;
    const other = await getThread(s.deps, as(uuidv7()), threadId);
    expect(other?.turns[0]?.message.attachments).toEqual([{ kind: "app_element", id: pick.id, title: null }]);

    const given = await s.tenant((tx) => conversationAttachments(tx, as(s.userId), threadId, s.connectionId));
    expect(given.missing).toBe(0);
    expect(given.items).toEqual([
      {
        kind: "app_element",
        id: pick.id,
        title: label,
        dashboardId: mine,
        revision: `rev-${mine}`,
        file: "/components/Queue.tsx",
        line: 22,
        tag: "li",
        text: "#4656 urgent",
        snippet: expect.stringContaining('22 >       <li className="row">{t.subject}</li>'),
        changed: false,
      },
    ]);
    const snippet = (given.items[0] as { snippet: string }).snippet.split("\n");
    // Ten lines either side, numbered, cut at the file's end.
    expect(snippet[0]).toBe("12 | // line 12");
    expect(snippet.at(-1)).toBe("30 | // line 30");
    expect(snippet.join("\n")).not.toContain("forged");

    // Saved since: given as it was, said to have changed.
    await s.t.owner`update app.dashboard_draft set revision = 'rev-later' where dashboard_id = ${mine}`;
    const later = await s.tenant((tx) => conversationAttachments(tx, as(s.userId), threadId, s.connectionId));
    expect(later.items[0]).toMatchObject({ kind: "app_element", changed: true });
    // Deleted: gone, and counted.
    await s.t.owner`update app.dashboard set deleted_at = now() where id = ${mine}`;
    const gone = await s.tenant((tx) => conversationAttachments(tx, as(s.userId), threadId, s.connectionId));
    expect(gone).toEqual({ items: [], missing: 1 });
  });

  it("refuses a file the App doesn't have, a line out of range, a revision it never had, and someone else's App", async () => {
    const mine = await app(s.userId);
    const theirs = await app(uuidv7());
    expect(await refused(ask("This?", [piece(mine, { file: "/components/Missing.tsx" })]))).toBe(
      "The App has no file /components/Missing.tsx: select the piece of the App again.",
    );
    expect(await refused(ask("This?", [piece(mine, { line: 31 })]))).toBe(
      "/components/Queue.tsx has no line 31: select the piece of the App again.",
    );
    expect(await refused(ask("This?", [piece(mine, { revision: "rev-never" })]))).toBe(
      "The App has changed since that was drawn: select the piece of the App again.",
    );
    const notTheirs = "Only those who change an App select a piece of it, and you don't change this one.";
    expect(await refused(ask("This?", [piece(theirs)]))).toBe(notTheirs);
    // Shared with them to view, it still isn't theirs to select in; shared to edit, it is.
    const shared = await app(uuidv7());
    await s.t.owner`
      insert into app.dashboard_share (org_id, id, dashboard_id, user_id, role, added_by)
      values (${s.orgId}, ${uuidv7()}, ${shared}, ${s.userId}, 'view', ${uuidv7()})`;
    expect(await refused(ask("This?", [piece(shared)]))).toBe(notTheirs);
    await s.t.owner`update app.dashboard_share set role = 'edit' where dashboard_id = ${shared}`;
    expect(await refused(ask("This?", [piece(shared)]))).toBe("ok");
    expect(await refused(ask("This?", [piece(mine, { dashboardId: undefined })]))).toBe(
      "That selection is missing where it came from: select the piece of the App again.",
    );
    // Counted with everything else a question takes.
    const six = Array.from({ length: 6 }, (_, i) => piece(mine, { line: i + 1 }));
    expect(await refused(ask("All of these?", six))).toBe("Attach up to 5 things to a question.");
  });
});

describe("an image someone attached", () => {
  // A PNG's signature and a little: what the reader and the check go by.
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).toString("base64");

  it("is kept on the question by its bytes and given to the runs after it; another type is refused", async () => {
    const image = { kind: "image" as const, id: uuidv7(), name: "chart.png", mediaType: "image/png", data: png };
    const { threadId } = await ask("What does my chart show?", [image]);
    const view = await getThread(s.deps, as(s.userId), threadId);
    expect(view?.turns[0]?.message.attachments).toEqual([{ kind: "image", id: image.id, title: "chart.png" }]);
    const given = await s.tenant((tx) => conversationAttachments(tx, as(s.userId), threadId, s.connectionId));
    expect(given.items).toEqual([
      { kind: "image", id: image.id, title: "chart.png", mediaType: "image/png", data: png },
    ]);
    expect(await refused(ask("Lies?", [{ ...image, id: uuidv7(), mediaType: "image/jpeg" }]))).toBe(
      "An image is a PNG, JPEG, GIF or WebP of at most 2 MB.",
    );
    const three = Array.from({ length: 3 }, () => ({ ...image, id: uuidv7() }));
    expect(await refused(ask("Three?", three))).toBe("Attach up to 2 images to a question.");
  });
});

describe("a file someone attached", () => {
  it("is kept on the question as the asker's text, named on its chip, given to runs, and bounded", async () => {
    const file = { kind: "file" as const, id: uuidv7(), name: "q3-targets.md", text: "# Q3\nMRR target: $400,000" };
    const { threadId } = await ask("How did MRR do against the target?", [file]);
    const view = await getThread(s.deps, as(s.userId), threadId);
    // The chip names it; the text never leaves with the thread.
    expect(view?.turns[0]?.message.attachments).toEqual([{ kind: "file", id: file.id, title: "q3-targets.md" }]);
    const given = await s.tenant((tx) => conversationAttachments(tx, as(s.userId), threadId, s.connectionId));
    expect(given.items).toEqual([{ kind: "file", id: file.id, title: "q3-targets.md", text: file.text }]);
    const big = { ...file, id: uuidv7(), text: "x".repeat(64 * 1024 + 1) };
    expect(await refused(ask("Big?", [big]))).toBe("A file's text is kept up to 64 KB.");
    expect(await refused(ask("Path?", [{ ...file, id: uuidv7(), name: "../etc/passwd" }]))).toBe(
      "A file needs a plain name and its text.",
    );
    const four = Array.from({ length: 4 }, (_, i) => ({ ...file, id: uuidv7(), name: `f${i}.md` }));
    expect(await refused(ask("Four?", four))).toBe("Attach up to 3 files to a question.");
  });
});

describe("what a run is given", () => {
  it("each attachment as Ask answers with it, while the asker can still read it", async () => {
    const { threadId } = await ask("Revenue?", [{ kind: "guide", id: guide }]);
    await ask("And MRR?", [{ kind: "metric", id: mrr }], threadId);
    const given = await s.tenant((tx) => conversationAttachments(tx, as(s.userId), threadId, s.connectionId));
    expect(given.missing).toBe(0);
    expect(given.items.map((i) => [i.kind, i.title])).toEqual([
      ["metric", "Monthly recurring revenue"],
      ["guide", "Fiscal year starts in February"],
    ]);
    expect(given.items[0]).toMatchObject({ name: "mrr", released: true, editable: false });
    expect(given.items[1]).toMatchObject({ version: 1, body: "Our fiscal year starts on February 1." });
    // Taken back since it was attached: gone from the run, and counted.
    await s.t.owner`update app.context_item set released_version = null where id = ${guide}`;
    const after = await s.tenant((tx) => conversationAttachments(tx, as(s.userId), threadId, s.connectionId));
    expect(after.items.map((i) => i.title)).toEqual(["Monthly recurring revenue"]);
    expect(after.missing).toBe(1);
    await s.t.owner`update app.context_item set released_version = 1 where id = ${guide}`;
  });
});

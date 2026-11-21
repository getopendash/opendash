// mcp_find, the analyst's way into a workspace's connected services: every service turned on is always listed,
// however many tools come before it, with its tools named compactly, listed with what each does when one service is
// asked for, and searched by what they do, ranked, each match whole. The workspace is three services with 18, 40 and
// 98 tools and one with none, as one real workspace has them by shape.
import { randomBytes } from "node:crypto";
import { createSecretStore, localKek, mcp } from "@opendash/core";
import { sql, uuidv7 } from "@opendash/db";
import { createOrg, freshDatabase, type TestDatabase, withSystemOn, withTenantOn } from "@opendash/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mcpFind } from "../src/tools/mcp";
import { findResult, SEARCH_CHARS, wordsOf } from "../src/tools/mcp-find";
import type { ToolContext } from "../src/tools/types";
import { type FixtureServer, WORKSPACE } from "./helpers/mcp-tools";

interface Line {
  server: string;
  server_id: string;
  status: string;
  tool_count: number;
  names?: string[];
  more?: number;
  tools?: { tool: string; title?: string; about?: string; input?: string; not_usable?: string }[];
}
interface Shown {
  servers: Line[];
  tools?: { server_id: string; tool: string; about?: string; input?: string; not_usable?: string }[];
  also?: { server_id: string; tool: string }[];
  note?: string;
}

const destructive = (a: { readOnlyHint?: boolean; destructiveHint?: boolean }) =>
  a.readOnlyHint !== true && a.destructiveHint !== false;

/** The workspace as core's findTools gives it: every server with its state, every usable tool. */
const found = (workspace: FixtureServer[] = WORKSPACE): mcp.FoundServer[] =>
  workspace.map((s) => ({
    id: `id-${s.slug}`,
    name: s.name,
    auth: s.auth,
    access: s.auth === "none" ? "shared" : "personal",
    state: s.auth === "none" ? "ready" : "connect",
    tools: s.tools.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      readOnly: t.annotations.readOnlyHint === true,
      asks: t.annotations.readOnlyHint !== true,
      destructive: destructive(t.annotations),
      inputSchema: t.inputSchema,
    })),
  }));
const find = (input: { query?: string; server_id?: string }, workspace?: FixtureServer[]) => {
  const result = findResult(found(workspace), input);
  return { shown: result.value as unknown as Shown, size: JSON.stringify(result.value).length, ...result };
};
const toolOf = (server: string, name: string) =>
  WORKSPACE.find((s) => s.name === server)?.tools.find((t) => t.name === name);
const callableCount = (s: FixtureServer) => s.tools.filter((t) => !destructive(t.annotations)).length;

describe("every service turned on is listed, from the database", () => {
  const previousFlag = process.env.OPENDASH_MCP;
  let t: TestDatabase;
  let deps: mcp.McpDeps;
  const orgId = uuidv7();
  const admin = uuidv7();
  const ids = new Map<string, string>();
  /** What the harness hands mcp_find: the person who asked in OpenDash, with connected services on. */
  const ctx = () =>
    ({
      deps: { mcp: deps },
      run: { orgId, background: false, trigger: "user" },
      asker: admin,
    }) as unknown as ToolContext;
  const call = { rowId: "row", signal: new AbortController().signal };

  beforeAll(async () => {
    process.env.OPENDASH_MCP = "1";
    t = await freshDatabase();
    await createOrg(t, orgId, "Acme");
    await t.auth.client`insert into auth.user (id, name, email, email_verified)
      values (${admin}, 'Maya', ${`maya-${admin}@acme.test`}, true)`;
    await t.auth.client`insert into auth.member (id, organization_id, user_id, role, created_at)
      values (${uuidv7()}, ${orgId}, ${admin}, 'admin', now())`;
    deps = {
      secrets: createSecretStore({ kek: localKek(randomBytes(32).toString("base64")) }),
      edition: "community",
      withTenant: (c, fn) => withTenantOn(t.app, c, fn),
      redirectUrl: "https://opendash.test/api/mcp/callback",
    };
    // Approved as an admin would, at addresses never called here; their tools recorded as a listing would.
    for (const server of WORKSPACE) {
      const { id } = await mcp.approveServer(
        deps,
        { orgId, userId: admin },
        { name: server.name, url: `http://127.0.0.1:9/${server.slug}`, auth: server.auth },
      );
      ids.set(server.name, id);
      for (const tool of server.tools) {
        await withSystemOn(t.system, (tx) =>
          tx.execute(sql`
            insert into app.mcp_tool (org_id, server_id, name, title, description, input_schema, annotations, digest,
                                      reviewed_digest, tier)
            values (${orgId}, ${id}, ${tool.name}, ${tool.title}, ${tool.description},
                    ${JSON.stringify(tool.inputSchema)}::jsonb, ${JSON.stringify(tool.annotations)}::jsonb, 'd', 'd',
                    ${tool.annotations.readOnlyHint ? "always" : "ask"})`),
        );
      }
    }
    // A blocked tool, and one the server stopped listing: neither is offered.
    await withSystemOn(t.system, async (tx) => {
      await tx.execute(sql`update app.mcp_tool set tier = 'blocked' where org_id = ${orgId} and name = 'getHealth'`);
      await tx.execute(
        sql`update app.mcp_tool set status = 'removed' where org_id = ${orgId} and name = 'list_countries'`,
      );
    });
  });

  afterAll(async () => {
    process.env.OPENDASH_MCP = previousFlag;
    await t?.drop();
  });

  it("names each one, the last alphabetically too, however many tools the others have", async () => {
    const { value, summary } = await mcpFind.execute({}, ctx(), call);
    const shown = JSON.stringify(value);
    if (process.env.PRINT_SIZES) console.log(`SIZE mcp_find with no query: ${shown.length}`);
    for (const server of WORKSPACE) expect(shown, server.name).toContain(ids.get(server.name));
    // Names only: a line a service and its tools' names, a few KB for 156 tools.
    expect(shown.length).toBeLessThan(4_000);
    const lines = (value as Shown).servers;
    expect(lines.map((l) => [l.server, l.status])).toEqual([
      ["Observability", "ready"],
      ["Replays", "ready"],
      ["Tracker", "ready"],
      ["Wiki", "the person hasn't connected it: calling it shows them a Connect card"],
    ]);
    expect(lines[0]?.names).not.toContain("getHealth");
    expect(lines[1]?.names).not.toContain("list_countries");
    expect(summary).toMatchObject({ query: null, servers: 4 });
  });

  it("a question finds its tool on any of them, with all of its input", async () => {
    const { value } = await mcpFind.execute({ query: "llm cost by feature" }, ctx(), call);
    const [first] = (value as Shown).tools ?? [];
    expect(first).toMatchObject({ server_id: ids.get("Observability"), tool: "getTraceCosts" });
    expect(JSON.parse(first?.input ?? "{}")).toEqual(toolOf("Observability", "getTraceCosts")?.inputSchema);
  });
});

describe("with nothing asked", () => {
  it("is every service's line and its tools' names: no descriptions, no inputs", () => {
    const { shown, summary, size } = find({});
    if (process.env.PRINT_SIZES) console.log(`SIZE names of 156 tools: ${size}`);
    expect(size).toBeLessThan(4_000);
    expect(shown.servers.map((l) => [l.server, l.tool_count])).toEqual(
      WORKSPACE.map((s) => [s.name, callableCount(s)]),
    );
    const tracker = shown.servers.find((l) => l.server === "Tracker");
    expect(tracker?.names).toHaveLength(60);
    expect(tracker?.more).toBe(callableCount(WORKSPACE[2] as FixtureServer) - 60);
    // A tool it never calls isn't offered by name (a search still finds it, and says why).
    expect(shown.servers[0]?.names).not.toContain("deleteTrace");
    expect(JSON.stringify(shown)).not.toMatch(/"(about|input)"/);
    // A service nobody has signed in to has no tools yet, and is listed all the same.
    expect(shown.servers.at(-1)).toMatchObject({ server: "Wiki", tool_count: 0 });
    expect(shown.note).toContain("get its input");
    expect(summary).toEqual({ query: null, servers: 4, found: WORKSPACE.reduce((n, s) => n + callableCount(s), 0) });
  });

  it("a server whose tools don't say they only read isn't shown as empty", () => {
    const unsaid = WORKSPACE.map((s) => ({ ...s, tools: s.tools.map((x) => ({ ...x, annotations: {} })) }));
    expect(find({}, unsaid).shown.servers[0]).toMatchObject({
      server: "Observability",
      tool_count: 0,
      never_called: 18,
    });
    expect(find({}).shown.servers[0]).toMatchObject({ tool_count: 17, never_called: 1 });
    expect(find({}).shown.servers[3]).not.toHaveProperty("never_called");
  });

  it("no service turned on says so", () => {
    expect(findResult([], {}).value).toEqual({ servers: [], note: expect.stringContaining("No service") });
  });
});

describe("one service's tools", () => {
  it("a server_id lists each of its tools with what it does in a sentence, never its input", () => {
    const { shown, summary, size } = find({ server_id: "id-tracker" });
    if (process.env.PRINT_SIZES) console.log(`SIZE Tracker's 98 tools listed: ${size}`);
    const tracker = shown.servers.find((l) => l.server === "Tracker");
    expect(tracker?.tools).toHaveLength(98);
    expect(tracker?.tools?.[0]).toEqual({
      tool: "create-attachment",
      title: "New attachment",
      // Its first sentence.
      about: "Creates a new attachment.",
      // It adds, so it asks the person first.
      asks_first: true,
    });
    expect(tracker?.tools?.every((x) => (x.about?.length ?? 0) <= 160 && !x.input)).toBe(true);
    // The ones it never calls come last, saying why.
    expect(tracker?.tools?.at(-1)).toMatchObject({ tool: "update-worklog", not_usable: expect.any(String) });
    // The other services stay a line each.
    expect(shown.servers.filter((l) => l.tools)).toHaveLength(1);
    expect(size).toBeLessThan(24_000);
    expect(summary).toMatchObject({ server_id: "id-tracker", servers: 4, found: 98 });
  });

  it("a query that only names a service is that service's listing, not eight inputs", () => {
    const { shown } = find({ query: "tracker" });
    expect(shown.tools).toBeUndefined();
    expect(shown.servers.find((l) => l.server === "Tracker")?.tools).toHaveLength(98);
  });

  it("a server_id that isn't one still shows every service and its tools' names", () => {
    const { shown } = find({ server_id: "nope" });
    expect(shown.servers).toHaveLength(4);
    expect(shown.servers[1]?.names?.length).toBeGreaterThan(0);
    expect(shown.note).toContain("No connected service has that server_id");
  });
});

describe("searching by what a tool does", () => {
  it("a question with words no one tool has all of (which found nothing before) still finds it", () => {
    const { shown, size } = find({ query: "llm cost by feature" });
    if (process.env.PRINT_SIZES) console.log(`SIZE "llm cost by feature": ${size}`);
    const first = shown.tools?.[0];
    expect(first?.tool).toBe("getTraceCosts");
    // Whole: all it says and all it takes.
    expect(first?.about).toBe(toolOf("Observability", "getTraceCosts")?.description);
    expect(JSON.parse(first?.input ?? "{}")).toEqual(toolOf("Observability", "getTraceCosts")?.inputSchema);
    // Every service is still listed, a line each.
    expect(shown.servers.map((l) => l.server)).toEqual(["Observability", "Replays", "Tracker", "Wiki"]);
  });

  it("ranks the tool that fits the question first, though its words are spread over several", () => {
    const { shown } = find({ query: "how much did our LLM calls cost each feature last month?" });
    expect(shown.tools?.[0]?.tool).toBe("getTraceCosts");
  });

  it("a word in a tool's name counts for more than in another's description", () => {
    // listSpans is named for spans; getTrace says it has them.
    expect(find({ query: "spans" }).shown.tools?.[0]?.tool).toBe("listSpans");
  });

  it("a word finds its plural, and the start of a longer one", () => {
    expect(find({ query: "segment" }).shown.tools?.map((x) => x.tool)).toContain("list_segments");
  });

  it("a tool that fits more of the words ranks above one that fits one of them better", () => {
    const shop: FixtureServer = {
      name: "Shop",
      slug: "shop",
      auth: "none",
      tools: [
        ["orders", "Every sale, newest first."],
        ["refunds", "Money given back, newest first."],
        ["weekly_report", "Orders and refunds, by week."],
        ["customers", "Everyone who bought."],
        ["products", "Everything on sale."],
      ].map(([name, description]) => ({
        name: name as string,
        title: "",
        description: description as string,
        inputSchema: {},
        annotations: { readOnlyHint: true },
      })),
    };
    expect(find({ query: "orders refunds" }, [shop]).shown.tools?.[0]?.tool).toBe("weekly_report");
  });

  it("a rare word counts for more than a word in most tools' names", () => {
    // Dozens of tools are named list…; one is about costs.
    const { shown } = find({ query: "list costs" });
    expect(shown.tools?.map((x) => x.tool)).toEqual(["getTraceCosts"]);
    expect(shown.also?.length).toBeGreaterThan(0);
  });

  it("words in many tools alike are answered with names, not a page of inputs", () => {
    const { shown, size } = find({ query: "get" });
    expect(shown.tools).toEqual([]);
    expect(shown.also).toHaveLength(15);
    expect(shown.note).toContain("too many tools");
    expect(size).toBeLessThan(4_000);
  });

  it("words naming a service keep the search to it", () => {
    const { shown } = find({ query: "tracker comments" });
    const tools = shown.tools ?? [];
    expect(tools[0]?.tool).toBe("list-comments");
    expect(tools.every((x) => x.server_id === "id-tracker")).toBe(true);
    // Observability's listComments is about comments too, and isn't the tracker's.
    expect(JSON.stringify(shown)).not.toContain("listComments");
  });

  it("a service named whose tools don't fit the words: the words are searched everywhere", () => {
    expect(find({ query: "replays trace costs" }).shown.tools?.[0]?.tool).toBe("getTraceCosts");
  });

  it("a tool that may delete or overwrite ranks last, saying why, with no input", () => {
    const tools = find({ query: "trace" }).shown.tools ?? [];
    expect(tools.length).toBeGreaterThan(2);
    expect(tools.at(-1)).toMatchObject({ tool: "deleteTrace", not_usable: expect.any(String) });
    expect(tools.at(-1)?.input).toBeUndefined();
    expect(tools.slice(0, -1).every((x) => !x.not_usable)).toBe(true);
  });

  it("no tool matching still shows every service and its tools' names, and says what to try", () => {
    const { shown, summary } = find({ query: "zebra quantum" });
    expect(shown.servers).toHaveLength(4);
    expect(shown.servers[2]?.names?.length).toBe(60);
    expect(shown.note).toContain("try other words");
    expect(shown.note).not.toMatch(/answer from the sources|say so/i);
    expect(summary.found).toBe(0);
  });
});

describe("a tool asked for by its name", () => {
  it("comes first and whole, however it's written", () => {
    for (const query of ["get-issue", "get_issue", "`get-issue`"]) {
      const first = find({ query }).shown.tools?.[0];
      expect(first?.tool, query).toBe("get-issue");
      expect(JSON.parse(first?.input ?? "{}")).toEqual(toolOf("Tracker", "get-issue")?.inputSchema);
    }
    expect(find({ query: "getLLMUsage" }).shown.tools?.[0]?.tool).toBe("getLLMUsage");
  });

  it("names several at once; others that fit are named after them", () => {
    const { shown } = find({ query: "get-issue, list-comments" });
    expect(shown.tools?.map((x) => x.tool)).toEqual(["get-issue", "list-comments"]);
    expect(shown.also?.length).toBeGreaterThan(0);
  });

  it("a one-word name is the tool only when it's the whole query; the same name on two services is both", () => {
    expect(find({ query: "search" }).shown.tools?.map((x) => [x.server_id, x.tool])).toEqual([
      ["id-observability", "search"],
      ["id-tracker", "search"],
    ]);
    expect(find({ query: "search", server_id: "id-tracker" }).shown.tools?.map((x) => x.server_id)).toEqual([
      "id-tracker",
    ]);
    // "search issues" is a search, not the tool named search.
    expect(find({ query: "search issues" }).shown.tools?.[0]?.tool).toBe("search-issues");
  });
});

describe("how much a search shows", () => {
  const QUERIES = [
    "llm cost by feature",
    "trace",
    "issues",
    "sessions with errors",
    "segments",
    "tracker comments",
    "search",
    "get-issue, list-comments, getTrace, list_sessions",
  ];

  it(`stays within ${SEARCH_CHARS.toLocaleString("en-US")} characters, each tool whole`, () => {
    for (const query of QUERIES) {
      const { shown, size } = find({ query });
      if (process.env.PRINT_SIZES) console.log(`SIZE "${query}": ${size}`);
      expect(JSON.stringify(shown.tools).length, query).toBeLessThanOrEqual(SEARCH_CHARS);
      expect(shown.tools?.length ?? 0, query).toBeLessThanOrEqual(15);
    }
  });

  it("a tool larger than the bound is shown whole, and the ones after it are named", () => {
    const huge = {
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: 400 }, (_, i) => [`dimension_${i}`, { type: "string", description: "x".repeat(100) }]),
      ),
    };
    const workspace = WORKSPACE.map((s) => ({
      ...s,
      tools: s.tools.map((x) => (x.name === "getTraceCosts" ? { ...x, inputSchema: huge } : x)),
    }));
    const { shown } = find({ query: "llm cost by feature" }, workspace);
    expect(shown.tools?.map((x) => x.tool)).toEqual(["getTraceCosts"]);
    expect(JSON.parse(shown.tools?.[0]?.input ?? "{}")).toEqual(huge);
    expect(shown.also?.map((x) => x.tool)).toEqual(expect.arrayContaining(["getLLMUsage"]));
  });
});

describe("words of names and text", () => {
  it("takes snake_case, kebab-case and camelCase apart, acronyms too", () => {
    expect(wordsOf("get_session_events")).toEqual(["get", "session", "events"]);
    expect(wordsOf("list-comments")).toEqual(["list", "comments"]);
    expect(wordsOf("getLLMUsage")).toEqual(["get", "llm", "usage"]);
    expect(wordsOf("What LLM calls cost, per trace.")).toEqual(["what", "llm", "calls", "cost", "per", "trace"]);
  });
});

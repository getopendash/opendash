import { brandOfDialect, brandOfHost } from "@opendash/tokens/brands";
import { describe, expect, it } from "vitest";
import { sourceMark } from "../src/dashboard/marks";

describe("a source's mark", () => {
  it("is the service's own by the server's address, any name under its domain, with or without a port", () => {
    expect(brandOfHost("mcp.atlassian.com", "Jira")?.key).toBe("jira");
    expect(brandOfHost("mcp.atlassian.com", "Confluence")?.key).toBe("confluence");
    expect(brandOfHost("mcp.atlassian.com", "Atlassian")?.key).toBe("atlassian");
    expect(brandOfHost("api.githubcopilot.com", "GitHub")?.key).toBe("github");
    expect(brandOfHost("acme.zendesk.com:443", "Support")?.key).toBe("zendesk");
    expect(brandOfHost("MCP.Notion.com.", "Notes")?.key).toBe("notion");
  });

  it("is never chosen by the name alone: a brand's name on another address gets the letter", () => {
    expect(brandOfHost("jira-mcp.example.com", "Jira")).toBeNull();
    expect(brandOfHost("notatlassian.com", "Jira")).toBeNull();
    expect(brandOfHost("atlassian.com.evil.io", "Jira")).toBeNull();
    expect(brandOfHost("", "GitHub")).toBeNull();
  });

  it("is a database's by its dialect, and none for one without a mark (never another database's)", () => {
    expect(brandOfDialect("postgres")?.key).toBe("postgres");
    expect(brandOfDialect("databricks")?.key).toBe("databricks");
    expect(brandOfDialect("mssql")).toBeNull();
    expect(brandOfDialect("lake")).toBeNull();
  });

  it("goes to an App's frame as one path in the source's colour, on white where that colour reads there", () => {
    const jira = sourceMark({ url: "https://mcp.atlassian.com/v1/mcp", name: "Jira" });
    expect(jira).toMatchObject({ title: "Jira", viewBox: "0 0 24 24", bg: "#0052cc", onWhite: true });
    expect(jira?.path).toMatch(/^M/);
    // Yellow doesn't read on white: it keeps its tile, the mark in ink.
    expect(sourceMark({ dialect: "clickhouse" })).toMatchObject({ bg: "#ffcc01", fg: "#161616", onWhite: false });
    expect(sourceMark({ url: "not an address", name: "Jira" })).toBeUndefined();
    expect(sourceMark({ dialect: "mssql" })).toBeUndefined();
    expect(sourceMark(undefined)).toBeUndefined();
  });
});

// The Sources list's status rules, apart from the database (the query is covered by catalog-sync.test.ts; data
// timestamps by the connectors' profiling tests).
import { describe, expect, it } from "vitest";
import { sourceStatus } from "../src";

describe("source status", () => {
  const base = { connection: "ok" as const, writeAccess: false, latestRun: "succeeded" as const, learnedBefore: true };

  it("goes by precedence: disabled, unreachable, failing, failed, learning, write access, healthy", () => {
    expect(sourceStatus(base)).toBe("healthy");
    expect(sourceStatus({ ...base, writeAccess: true })).toBe("write_access");
    expect(sourceStatus({ ...base, latestRun: "running", learnedBefore: false })).toBe("learning");
    expect(sourceStatus({ ...base, latestRun: "queued" })).toBe("syncing");
    expect(sourceStatus({ ...base, latestRun: "failed", writeAccess: true })).toBe("failed");
    expect(sourceStatus({ ...base, connection: "error", latestRun: "failed" })).toBe("error");
    expect(sourceStatus({ ...base, connection: "disabled", latestRun: "running" })).toBe("disabled");
    expect(sourceStatus({ ...base, latestRun: null, learnedBefore: false })).toBe("healthy");
    // Queries that can't connect come before a failed sync, after a failed check.
    expect(sourceStatus({ ...base, queriesFailing: true, latestRun: "failed" })).toBe("failing");
    expect(sourceStatus({ ...base, queriesFailing: true, connection: "error" })).toBe("error");
  });
});

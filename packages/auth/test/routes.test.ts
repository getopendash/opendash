import { describe, expect, it } from "vitest";
import { safeRedirectPath } from "../src/routes";

describe("safeRedirectPath", () => {
  it("keeps same-site paths, with their query and hash", () => {
    expect(safeRedirectPath("/")).toBe("/");
    expect(safeRedirectPath("/invite/01a11d00?x=1#top")).toBe("/invite/01a11d00?x=1#top");
    expect(safeRedirectPath(["/welcome/password", "/other"])).toBe("/welcome/password");
    expect(safeRedirectPath("/a/./b/../c")).toBe("/a/c");
  });

  it("refuses anything that a browser would send to another site", () => {
    for (const bad of [
      "//evil.com",
      "/\\evil.com",
      "/\t/evil.com",
      "/\n/evil.com",
      "/\r\n/evil.com",
      "\\/evil.com",
      "/.//evil.com",
      "/..//evil.com",
      "/a/..//evil.com",
      "/.\\/evil.com",
      "/./\\evil.com",
      "/%2e//evil.com",
      "https://evil.com",
      "javascript:alert(1)",
      "evil.com",
      "",
      null,
      undefined,
    ]) {
      expect(safeRedirectPath(bad)).toBeNull();
    }
  });
});

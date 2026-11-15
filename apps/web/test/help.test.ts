// Where people get help on an instance: only what its operator set, and only when it's what it should be.
import { describe, expect, it } from "vitest";
import { helpLinks, supportEmail } from "../lib/help";

describe("an instance's help links", () => {
  it("shows the docs, the support address and the status page its operator set", () => {
    expect(
      helpLinks({
        OPENDASH_SUPPORT_EMAIL: "hello@opendash.test",
        OPENDASH_DOCS_URL: "https://docs.opendash.test",
        OPENDASH_STATUS_URL: "https://status.opendash.test/",
      }),
    ).toEqual([
      { id: "docs", label: "Docs", href: "https://docs.opendash.test/" },
      { id: "support", label: "Contact support", href: "mailto:hello@opendash.test" },
      { id: "status", label: "Status", href: "https://status.opendash.test/" },
    ]);
  });

  it("shows nothing on an instance that set none", () => {
    expect(helpLinks({})).toEqual([]);
    expect(helpLinks({ OPENDASH_SUPPORT_EMAIL: " ", OPENDASH_DOCS_URL: "" })).toEqual([]);
  });

  it("leaves out anything that isn't a web address or an email address", () => {
    expect(
      helpLinks({
        OPENDASH_SUPPORT_EMAIL: "hello@opendash.test?subject=<x>",
        OPENDASH_DOCS_URL: "javascript:alert(1)",
        OPENDASH_STATUS_URL: "status page",
      }),
    ).toEqual([]);
    expect(supportEmail({ OPENDASH_SUPPORT_EMAIL: "Support <hello@opendash.test>" })).toBeNull();
  });
});
